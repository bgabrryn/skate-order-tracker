// index.js - Main Express Server
const express = require('express');
const crypto = require('crypto');
const { Client } = require('@notionhq/client');

const app = express();
const path = require('path');

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// Serve static files from the React app
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Initialize Notion
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function generateMagicToken(orderNumber) {
  const SECRET_KEY = process.env.SECRET_KEY;
  const payload = JSON.stringify({
    orderNumber,
    exp: Date.now() + (90 * 24 * 60 * 60 * 1000)
  });
  
  const hmac = crypto.createHmac('sha256', SECRET_KEY);
  hmac.update(payload);
  const signature = hmac.digest('hex');
  
  return Buffer.from(JSON.stringify({ payload, signature })).toString('base64url');
}

function validateMagicToken(token) {
  try {
    const SECRET_KEY = process.env.SECRET_KEY;
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString());
    const { payload, signature } = decoded;
    
    const hmac = crypto.createHmac('sha256', SECRET_KEY);
    hmac.update(payload);
    const expectedSignature = hmac.digest('hex');
    
    if (signature !== expectedSignature) return null;
    
    const data = JSON.parse(payload);
    if (data.exp < Date.now()) return null;
    
    return data.orderNumber;
  } catch (e) {
    return null;
  }
}

async function getOrderLineItems(orderNumber) {
  const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;
  const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
  
  const response = await fetch(
    `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/orders.json?name=${orderNumber}&status=any`,
    {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    }
  );
  
  const data = await response.json();
  const order = data.orders?.[0];
  
  if (!order) return null;
  
  return {
    orderNumber: order.name,
    customerName: `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim(),
    customerEmail: order.customer?.email,
    orderDate: order.created_at,
    lineItems: order.line_items.map(item => ({
      id: item.id,
      title: item.title,
      variant: item.variant_title,
      quantity: item.quantity,
      sku: item.sku,
      properties: item.properties
    }))
  };
}

async function getTrackingDataByOrder(orderNumber) {
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      property: 'Order Number',
      rich_text: {
        equals: orderNumber
      }
    }
  });
  
  if (response.results.length === 0) return null;
  
  return response.results.map(page => {
    const props = page.properties;
    
    return {
      id: page.id,
      orderNumber: props['Order Number']?.rich_text?.[0]?.text?.content,
      bootModel: props['Model of Boot']?.rich_text?.[0]?.text?.content,
      size: props['Size']?.rich_text?.[0]?.text?.content,
      customerName: props['Customer Name']?.title?.[0]?.text?.content,
      contactDetails: props['Contact Details']?.email || props['Contact Details']?.rich_text?.[0]?.text?.content,
      internalStatus: props['Status']?.select?.name,
      bootStatus: props['Boot Status']?.select?.name,
      bladeStatus: props['Blade Status']?.select?.name,
      bootNotes: props['Boot Notes']?.rich_text?.[0]?.text?.content || '',
      bladeNotes: props['Blade Notes']?.rich_text?.[0]?.text?.content || '',
      bootExpectedArrival: props['Boot Expected Arrival']?.date?.start,
      bladeExpectedArrival: props['Blade Expected Arrival']?.date?.start,
      lastReviewed: props['Last Reviewed']?.date?.start,
      supplier: props['Supplier']?.select?.name || props['Supplier']?.rich_text?.[0]?.text?.content
    };
  });
}

function mapStatusToKey(status) {
  const mapping = {
    'Placed with Supplier': 'placed',
    'Not in UK': 'not-in-uk',
    'On the way': 'on-the-way',
    'Ready to try on': 'ready-to-try',
    'Collected': 'collected'
  };
  return mapping[status] || 'placed';
}

// ============================================================================
// ROUTES
// ============================================================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ message: 'Skate Order Tracker API is running!' });
});

// Create Notion record from Shopify order
app.post('/api/create-notion-record', async (req, res) => {
  const { orderNumber, apiKey, customerName, customerEmail, lineItemTitles } = req.body;
  
  if (apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!orderNumber) {
    return res.status(400).json({ error: 'Order number required' });
  }
  
  try {
    // Check if record already exists
    const existing = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        property: 'Order Number',
        rich_text: {
          equals: orderNumber
        }
      }
    });
    
    if (existing.results.length > 0) {
      return res.status(200).json({ 
        message: 'Record already exists',
        exists: true 
      });
    }
    
    // Extract boot and blade info from line item titles (comma-separated string)
    let bootModel = '';
    let bladeModel = '';
    
    if (lineItemTitles) {
      const titles = lineItemTitles.split(',').map(t => t.trim());
      
      titles.forEach(title => {
        const isBoots = title.toLowerCase().includes('boot') || 
                        title.toLowerCase().includes('edea') ||
                        title.toLowerCase().includes('risport') ||
                        title.toLowerCase().includes('jackson');
                        
        const isBlades = title.toLowerCase().includes('blade') ||
                         title.toLowerCase().includes('wilson') ||
                         title.toLowerCase().includes('paramount');
        
        if (isBoots) {
          bootModel = title;
        }
        if (isBlades) {
          bladeModel = title;
        }
      });
    }
    
    // Create new Notion record
    const newPage = await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties: {
        'Order Number': {
          rich_text: [{ text: { content: orderNumber } }]
        },
        'Customer Name': {
          title: [{ text: { content: customerName || '' } }]
        },
        'Contact Details': {
          rich_text: [{ text: { content: customerEmail || '' } }]
        },
        'Model of Boot': {
          rich_text: [{ text: { content: bootModel } }]
        },
        'Size': {
          rich_text: [{ text: { content: '' } }]
        },

        'Boot Status': {
          select: { name: 'Placed with Supplier' }
        },
        'Blade Status': {
          select: { name: 'Placed with Supplier' }
        },
        'Last Reviewed': {
          date: { start: new Date().toISOString().split('T')[0] }
        }
      }
    });
    
    return res.status(200).json({ 
      message: 'Notion record created',
      pageId: newPage.id,
      success: true
    });
    
  } catch (error) {
    console.error('Error creating Notion record:', error);
    return res.status(500).json({ error: 'Failed to create Notion record' });
  }
});

// Generate magic link
app.post('/api/generate-link', async (req, res) => {
  const { orderNumber, apiKey } = req.body;
  
  if (apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!orderNumber) {
    return res.status(400).json({ error: 'Order number required' });
  }
  
  const token = generateMagicToken(orderNumber);
  const trackingUrl = `${process.env.BASE_URL}/track?token=${token}`;
  
  return res.status(200).json({ trackingUrl, token });
});

// Track order
app.get('/api/track', async (req, res) => {
  const { token } = req.query;
  
  if (!token) {
    return res.status(400).json({ error: 'Token required' });
  }
  
  const orderNumber = validateMagicToken(token);
  if (!orderNumber) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  
  try {
    const [shopifyData, notionData] = await Promise.all([
      getOrderLineItems(orderNumber),
      getTrackingDataByOrder(orderNumber)
    ]);
    
    if (!shopifyData || !notionData) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const items = [];
    const notionRecord = notionData[0];
    
    shopifyData.lineItems.forEach(lineItem => {
      const isBoots = lineItem.title.toLowerCase().includes('boot') || 
                      lineItem.title.toLowerCase().includes('edea') ||
                      lineItem.title.toLowerCase().includes('risport');
                      
      const isBlades = lineItem.title.toLowerCase().includes('blade') ||
                       lineItem.title.toLowerCase().includes('wilson') ||
                       lineItem.title.toLowerCase().includes('paramount');
      
      if (isBoots && notionRecord.bootStatus) {
        items.push({
          id: `boot-${lineItem.id}`,
          type: 'Boot',
          model: notionRecord.bootModel || lineItem.title,
          size: notionRecord.size || lineItem.variant,
          status: mapStatusToKey(notionRecord.bootStatus),
          supplier: notionRecord.supplier,
          location: null,
          estimatedArrival: notionRecord.bootExpectedArrival,
          notes: notionRecord.bootNotes,
          lastReviewed: notionRecord.lastReviewed ? 
            new Date(notionRecord.lastReviewed).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'long',
              year: 'numeric'
            }) : 
            new Date().toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'long',
              year: 'numeric'
            })
        });
      }
      
      if (isBlades && notionRecord.bladeStatus) {
        items.push({
          id: `blade-${lineItem.id}`,
          type: 'Blade',
          model: lineItem.title,
          size: lineItem.variant,
          status: mapStatusToKey(notionRecord.bladeStatus),
          supplier: notionRecord.supplier,
          location: null,
          estimatedArrival: notionRecord.bladeExpectedArrival,
          notes: notionRecord.bladeNotes,
          lastReviewed: notionRecord.lastReviewed ? 
            new Date(notionRecord.lastReviewed).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'long',
              year: 'numeric'
            }) : 
            new Date().toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'long',
              year: 'numeric'
            })
        });
      }
    });
    
    return res.status(200).json({
      orderNumber: shopifyData.orderNumber,
      customerName: shopifyData.customerName,
      orderDate: shopifyData.orderDate,
      items
    });
    
  } catch (error) {
    console.error('Error fetching tracking data:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

//

// Serve React app for all other routes (must be last)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});