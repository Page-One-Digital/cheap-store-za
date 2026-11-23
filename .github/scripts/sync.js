const admin = require('firebase-admin');
const axios = require('axios');

// 1. Authenticate with Firebase using encrypted GitHub Secret
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// 2. Read SMD Secrets from GitHub Vault
const SMD_CONFIG = {
  baseURL: 'https://api.smdtechnologies.com/v1',
  headers: {
    'Authorization': `Bearer ${process.env.SMD_BEARER_TOKEN}`,
    'ClientAccessKey': process.env.SMD_CLIENT_KEY
  }
};

async function fetchAllPages(endpoint) {
  let allData = [];
  let currentPage = 1;
  let totalPages = 1;

  do {
    try {
      const response = await axios.get(`${SMD_CONFIG.baseURL}/${endpoint}`, {
        headers: SMD_CONFIG.headers,
        params: { page: currentPage }
      });
      const { data, numberOfPages } = response.data;
      if (Array.isArray(data)) allData = allData.concat(data);
      totalPages = numberOfPages || 1;
      currentPage++;
    } catch (error) {
      console.error(`Error fetching ${endpoint} page ${currentPage}:`, error.message);
      break;
    }
  } while (currentPage <= totalPages);

  return allData;
}

async function runSync() {
  console.log('🔒 Securely fetching catalog from SMD Technologies...');

  const [products, media, prices, stock] = await Promise.all([
    fetchAllPages('products'),
    fetchAllPages('media'),
    fetchAllPages('prices'),
    fetchAllPages('stock')
  ]);

  const mediaMap = new Map();
  media.forEach(item => {
    if (!item.Sku) return;
    if (!mediaMap.has(item.Sku)) mediaMap.set(item.Sku, []);
    mediaMap.get(item.Sku).push(item);
  });

  const priceMap = new Map();
  prices.forEach(item => { if (item.Sku) priceMap.set(item.Sku, item); });

  const stockMap = new Map();
  stock.forEach(item => { if (item.Sku) stockMap.set(item.Sku, item); });

  console.log(`📦 Updating Firestore database with ${products.length} items...`);

  let batch = db.batch();
  let count = 0;

  for (const prod of products) {
    const sku = prod.Sku;
    if (!sku) continue;

    const productMedia = (mediaMap.get(sku) || []).sort((a, b) => (a.OrderWeight || 1) - (b.OrderWeight || 1));
    const imageUrls = productMedia.map(m => m.Url).filter(Boolean);

    const priceInfo = priceMap.get(sku) || {};
    const stockInfo = stockMap.get(sku) || {};
    const soh = stockInfo.SOH ?? 0;

    // Wholesale Cost incl. VAT and RRP
    const costPrice = parseFloat(priceInfo.PriceIncl || priceInfo.PriceExcl || 0);
    const rrp = parseFloat(priceInfo.PriceRRP || 0);

    // 1. Calculate 25% minimum markup price
    let calculatedPrice = costPrice * 1.25;

    // 2. If RRP exists and is higher than our 25% markup cost, use RRP; otherwise use 25% markup price
    let targetPrice = rrp > calculatedPrice ? rrp : calculatedPrice;

    // 3. Round to closest .99 cents
    let finalRetailPrice = 0;
    if (targetPrice > 0) {
      finalRetailPrice = Math.floor(targetPrice) + 0.99;
      // Ensure rounding down didn't drop us below the strict 25% margin boundary
      if (finalRetailPrice < calculatedPrice) {
        finalRetailPrice += 1.00;
      }
    }

    const productDoc = {
      sku: sku,
      name: prod.Name || prod.ShortDescription || 'SMD Product',
      category: prod.Category ? prod.Category.split('/')[0] : 'Accessories',
      brand: prod.Brand || '',
      price: finalRetailPrice,
      priceExcl: parseFloat(priceInfo.PriceExcl || 0),
      priceIncl: costPrice,
      priceRRP: rrp,
      stock: soh,
      visible: soh > 0, // Automatically hide items out of stock
      isBestSeller: false,
      image: imageUrls.join(','),
      description: prod.LongDescription || prod.ShortDescription || '',
      extra1: `• Brand: ${prod.Brand || 'N/A'}\n• Dimensions: ${prod.Height || 0}cm x ${prod.Width || 0}cm x ${prod.Depth || 0}cm\n• Weight: ${prod.Weight || 0}kg`,
      updatedAt: new Date().toISOString()
    };

    const docId = `smd_${sku.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const docRef = db.collection('cheap_products').doc(docId);
    batch.set(docRef, productDoc, { merge: true });
    count++;

    if (count % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }

  if (count % 400 !== 0) {
    await batch.commit();
  }

  console.log(`✅ Success! Synced ${count} items securely to Firebase.`);
  process.exit(0);
}

runSync();
