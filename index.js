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
  // Normalize order number - try both with and without # prefix
  const queryOrderNumber = orderNumber.startsWith('#') ? orderNumber : `#${orderNumber}`;
  
  console.log('[DEBUG] Querying Notion for order number:', orderNumber);
  console.log('[DEBUG] Also trying with # prefix:', queryOrderNumber);
  
  // Try with original format first
  let response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      property: 'Order Number',
      title: {
        equals: orderNumber
      }
    }
  });
  
  // If no results, try with # prefix
  if (response.results.length === 0 && !orderNumber.startsWith('#')) {
    console.log('[DEBUG] No results with original format, trying with # prefix');
    response = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        property: 'Order Number',
        title: {
          equals: queryOrderNumber
        }
      }
    });
  }
  
  if (response.results.length === 0) {
    console.warn('[DEBUG] No Notion records found for order:', orderNumber, 'or', queryOrderNumber);
    return null;
  }
  
  console.log(`[DEBUG] Found ${response.results.length} record(s) in Notion`);
  
  return response.results.map(page => {
    const props = page.properties;
    
    // Debug: Log all property names to help identify mismatches
    console.log('[DEBUG] Available Notion properties:', Object.keys(props));
    
    // Format Last Reviewed date if it exists
    let lastReviewed = null;
    if (props['Last Reviewed']?.date?.start) {
      const date = new Date(props['Last Reviewed'].date.start);
      lastReviewed = date.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      });
    }
    
    // Get boot status with comprehensive debugging and fallback
    let bootStatus = props['Boot Status']?.select?.name;
    
    // Debug logging
    if (props['Boot Status']) {
      console.log('[DEBUG] Boot Status property structure:', JSON.stringify(props['Boot Status'], null, 2));
      console.log('[DEBUG] Boot Status value:', bootStatus);
      
      // If select.name is null but property exists, log the full structure
      if (!bootStatus && props['Boot Status'].select === null) {
        console.warn('[DEBUG] Boot Status select is null - property may not be a Select type');
      }
    } else {
      console.warn('[DEBUG] Boot Status property not found in Notion page');
      // Try to find similar property names (case-insensitive, with/without spaces)
      const allProps = Object.keys(props);
      const similarProps = allProps.filter(key => {
        const lowerKey = key.toLowerCase().replace(/\s+/g, '');
        return lowerKey.includes('boot') && lowerKey.includes('status');
      });
      if (similarProps.length > 0) {
        console.warn('[DEBUG] Found similar properties:', similarProps);
        // Try the first similar property as fallback
        const fallbackProp = props[similarProps[0]];
        if (fallbackProp?.select?.name) {
          console.warn(`[DEBUG] Using fallback property "${similarProps[0]}" with value:`, fallbackProp.select.name);
          bootStatus = fallbackProp.select.name;
        }
      }
    }
    
    return {
      id: page.id,
      orderNumber: props['Order Number']?.title?.[0]?.text?.content,
      bootModel: props['Model of Boot']?.rich_text?.[0]?.text?.content,
      size: props['Size']?.rich_text?.[0]?.text?.content,
      customerName: props['Customer Name']?.rich_text?.[0]?.text?.content,
      contactDetails: props['Contact Details']?.rich_text?.[0]?.text?.content,
      internalStatus: props['Status']?.select?.name,
      bootStatus: bootStatus,
      bladeStatus: props['Blade Status']?.select?.name,
      bootNotes: props['Boot Notes']?.rich_text?.[0]?.text?.content || '',
      bladeNotes: props['Blade Notes']?.rich_text?.[0]?.text?.content || '',
      supplier: props['Supplier']?.select?.name || props['Supplier']?.rich_text?.[0]?.text?.content,
      lastReviewed: lastReviewed
    };
  });
}

function mapStatusToKey(status) {
  if (!status) return 'placed';
  
  // Normalize the status by trimming whitespace
  const normalizedStatus = status.trim();
  
  const mapping = {
    'Placed with Supplier': 'placed',
    'Not in UK': 'not-in-uk',
    'On the way': 'on-the-way',
    'Ready to try on': 'ready-to-try',
    'Collected': 'collected'
  };
  
  // Try exact match first
  if (mapping[normalizedStatus]) {
    return mapping[normalizedStatus];
  }
  
  // Try case-insensitive match
  const lowerStatus = normalizedStatus.toLowerCase();
  for (const [key, value] of Object.entries(mapping)) {
    if (key.toLowerCase() === lowerStatus) {
      return value;
    }
  }
  
  // Default fallback
  console.warn(`Unknown status value: "${status}" - defaulting to "placed"`);
  return 'placed';
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
        title: {
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
      console.log('[DEBUG] Processing lineItemTitles:', titles);
      
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
          console.log('[DEBUG] Identified boot model:', bootModel);
        }
        if (isBlades) {
          bladeModel = title;
          console.log('[DEBUG] Identified blade model:', bladeModel);
        }
      });
    }
    
    // Prepare properties for Notion
    const notionProperties = {
      'Order Number': {
        title: [{ text: { content: orderNumber } }]
      },
      'Customer Name': {
        rich_text: [{ text: { content: customerName || '' } }]
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
      }
    };
    
    console.log('[DEBUG] Creating Notion record with properties:', JSON.stringify(notionProperties, null, 2));
    
    // Create new Notion record
    const newPage = await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties: notionProperties
    });
    
    return res.status(200).json({ 
      message: 'Notion record created',
      pageId: newPage.id,
      success: true
    });
    
  } catch (error) {
    console.error('Error creating Notion record:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      status: error.status,
      body: error.body,
      stack: error.stack
    });
    return res.status(500).json({ 
      error: 'Failed to create Notion record',
      details: error.message || 'Unknown error',
      code: error.code
    });
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
  
  // Return as plain text so Shopify Flow can use it directly
  return res.status(200).send(trackingUrl);
});

// Track order
app.get('/api/track', async (req, res) => {
  // Prevent caching to ensure fresh data from Notion
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
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
    
    console.log('[DEBUG] shopifyData:', shopifyData ? 'found' : 'not found');
    console.log('[DEBUG] notionData:', notionData ? `${notionData.length} records` : 'not found');
    console.log('[DEBUG] orderNumber being queried:', orderNumber);
    
    if (!shopifyData) {
      console.warn('[DEBUG] Shopify data not found for order:', orderNumber);
      return res.status(404).json({ error: 'Order not found in Shopify' });
    }
    
    if (!notionData || notionData.length === 0) {
      console.warn('[DEBUG] Notion data not found for order:', orderNumber);
      return res.status(404).json({ error: 'Order not found in tracking database' });
    }
    
    const items = [];
    const notionRecord = notionData[0];
    
    if (!notionRecord) {
      console.error('[DEBUG] notionRecord is undefined');
      return res.status(404).json({ error: 'Tracking record not found' });
    }
    
    // Debug logging to help diagnose status issues
    console.log('[DEBUG] Full notionRecord:', JSON.stringify(notionRecord, null, 2));
    console.log('[DEBUG] Shopify lineItems:', JSON.stringify(shopifyData.lineItems, null, 2));
    if (notionRecord.bootStatus) {
      console.log(`[DEBUG] Boot Status from Notion: "${notionRecord.bootStatus}"`);
      console.log(`[DEBUG] Mapped Status Key: "${mapStatusToKey(notionRecord.bootStatus)}"`);
    } else {
      console.warn('[DEBUG] bootStatus is null or undefined in notionRecord');
    }
    
    shopifyData.lineItems.forEach(lineItem => {
      const isBoots = lineItem.title.toLowerCase().includes('boot') || 
                      lineItem.title.toLowerCase().includes('edea') ||
                      lineItem.title.toLowerCase().includes('risport');
                      
      const isBlades = lineItem.title.toLowerCase().includes('blade') ||
                       lineItem.title.toLowerCase().includes('wilson') ||
                       lineItem.title.toLowerCase().includes('paramount');
      
      console.log(`[DEBUG] Processing lineItem: "${lineItem.title}" - isBoots: ${isBoots}, bootStatus exists: ${!!notionRecord.bootStatus}`);
      
      if (isBoots) {
        // Use bootStatus if available, otherwise default to 'placed'
        const status = notionRecord.bootStatus ? mapStatusToKey(notionRecord.bootStatus) : 'placed';
        items.push({
          id: `boot-${lineItem.id}`,
          type: 'Boot',
          model: notionRecord.bootModel || lineItem.title,
          size: notionRecord.size || lineItem.variant,
          status: status,
          supplier: notionRecord.supplier,
          location: null,
          estimatedArrival: null,
          notes: notionRecord.bootNotes,
          lastReviewed: notionRecord.lastReviewed || new Date().toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'long',
            year: 'numeric'
          })
        });
        console.log(`[DEBUG] Added item with status: "${status}"`);
      } else {
        console.log(`[DEBUG] Skipping lineItem "${lineItem.title}" - not identified as boots`);
      }
    });
    
    console.log(`[DEBUG] Total items created: ${items.length}`);
    
    const responseData = {
      orderNumber: shopifyData.orderNumber,
      customerName: shopifyData.customerName,
      orderDate: shopifyData.orderDate,
      items
    };
    
    // Debug: Log what we're sending to frontend
    console.log('[DEBUG] Sending response to frontend:', JSON.stringify(responseData, null, 2));
    if (items.length > 0) {
      console.log('[DEBUG] Item status in response:', items[0].status);
    }
    
    return res.status(200).json(responseData);
    
  } catch (error) {
    console.error('Error fetching tracking data:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Serve React app for all other routes (must be last)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});