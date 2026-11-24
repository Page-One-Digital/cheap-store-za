const fs = require('fs');

const BASE_URL = 'https://api.smdtechnologies.com/v1';
const BEARER_TOKEN = process.env.SMD_BEARER_TOKEN;
const CLIENT_KEY = process.env.SMD_CLIENT_KEY;

const headers = {
  'Authorization': `Bearer ${BEARER_TOKEN}`,
  'ClientAccessKey': CLIENT_KEY
};

async function fetchAllPages(endpoint) {
  let allData = [];
  let page = 1;
  let totalPages = 1;

  do {
    const url = `${BASE_URL}/${endpoint}?page=${page}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.warn(`Failed fetching ${endpoint} page ${page}: ${res.statusText}`);
      break;
    }
    const json = await res.json();
    if (json.data && Array.isArray(json.data)) {
      allData.push(...json.data);
    }
    totalPages = json.numberOfPages || 1;
    page++;
  } while (page <= totalPages);

  return allData;
}

async function runSync() {
  console.log('Starting SMD API Sync...');
  
  const [productsRaw, mediaRaw, pricesRaw, stockRaw] = await Promise.all([
    fetchAllPages('products'),
    fetchAllPages('media'),
    fetchAllPages('prices'),
    fetchAllPages('stock')
  ]);

  console.log(`Fetched: ${productsRaw.length} products, ${mediaRaw.length} media, ${pricesRaw.length} prices, ${stockRaw.length} stock items.`);

  // Map media by SKU (OrderWeight 1 is primary image)
  const mediaMap = {};
  mediaRaw.forEach(item => {
    if (!item.Sku || !item.Url) return;
    if (!mediaMap[item.Sku] || item.OrderWeight === 1) {
      mediaMap[item.Sku] = item.Url;
    }
  });

  // Map prices by SKU
  const priceMap = {};
  pricesRaw.forEach(item => {
    const sku = item.Sku || item.ProductCode;
    if (!sku) return;
    const costIncl = parseFloat(item.PriceIncl || 0);
    priceMap[sku] = {
      costIncl,
      rrp: parseFloat(item.PriceRRp || 0)
    };
  });

  // Map stock levels (SOH) by SKU
  const stockMap = {};
  stockRaw.forEach(item => {
    if (item.Sku) {
      stockMap[item.Sku] = parseInt(item.SOH || 0, 10);
    }
  });

  // Combine into CHEAP website catalog schema
  const compiledProducts = productsRaw.map(prod => {
    const sku = prod.Sku;
    const priceInfo = priceMap[sku] || { costIncl: 0, rrp: 0 };
    const stockQty = stockMap[sku] ?? 0;
    const imageUrl = mediaMap[sku] || 'https://via.placeholder.com/400?text=No+Image';

    // Apply Cost + 25% Markup
    const retailPrice = priceInfo.costIncl > 0 ? (priceInfo.costIncl * 1.25) : 0;

    return {
      id: sku,
      name: prod.Name || prod.ShortDescription || 'Product',
      category: prod.Category ? prod.Category.split('/')[0] : 'General',
      brand: prod.Brand || '',
      price: parseFloat(retailPrice.toFixed(2)),
      priceRRP: parseFloat(priceInfo.rrp.toFixed(2)),
      stock: stockQty,
      visible: stockQty > 0 && retailPrice > 0,
      isBestSeller: false,
      image: imageUrl,
      description: prod.LongDescription || prod.ShortDescription || '',
      extra1: `SKU: ${sku}\nBrand: ${prod.Brand || 'N/A'}`
    };
  }).filter(p => p.price > 0);

  fs.writeFileSync('products.json', JSON.stringify(compiledProducts, null, 2));
  console.log(`Successfully compiled ${compiledProducts.length} live products into products.json`);
}

runSync().catch(err => {
  console.error('SMD Sync Failed:', err);
  process.exit(1);
});
