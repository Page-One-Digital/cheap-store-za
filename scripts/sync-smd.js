const fs = require('fs');

const BASE_URL = 'https://api.smdtechnologies.com/v1';
const BEARER_TOKEN = process.env.SMD_BEARER_TOKEN;
const CLIENT_KEY = process.env.SMD_CLIENT_KEY;

const headers = {
  'Authorization': `Bearer ${BEARER_TOKEN}`,
  'ClientAccessKey': CLIENT_KEY
};

function normalizeKey(val) {
  return String(val || '').trim().toLowerCase();
}

function deduplicateByKey(items, getKeyFn) {
  const map = new Map();
  for (const item of items) {
    const key = normalizeKey(getKeyFn(item));
    if (!key) continue;
    if (map.has(key)) {
      map.set(key, { ...map.get(key), ...item });
    } else {
      map.set(key, item);
    }
  }
  return Array.from(map.values());
}

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

  console.log(`Fetched raw: ${productsRaw.length} products, ${mediaRaw.length} media, ${pricesRaw.length} prices, ${stockRaw.length} stock items.`);

  // Deduplicate raw products by SKU (or Name fallback)
  const uniqueProductsRaw = deduplicateByKey(
    productsRaw,
    prod => prod.Sku || prod.ProductCode || prod.Name
  );

  // Map media by SKU (OrderWeight 1 is primary image)
  const mediaMap = {};
  mediaRaw.forEach(item => {
    const sku = item.Sku || item.ProductCode;
    if (!sku || !item.Url) return;
    if (!mediaMap[sku] || Number(item.OrderWeight) === 1) {
      mediaMap[sku] = item.Url;
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
    const sku = item.Sku || item.ProductCode;
    if (sku) {
      stockMap[sku] = parseInt(item.SOH || 0, 10);
    }
  });

  // Combine into CHEAP website catalog schema
  const compiledProducts = uniqueProductsRaw
    .map(prod => {
      const sku = prod.Sku || prod.ProductCode;
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
    })
    .filter(p => p.price > 0);

  // Final deduplication pass by ID/SKU and normalized product name
  const finalProducts = deduplicateByKey(
    compiledProducts,
    p => p.id || p.name
  );

  fs.writeFileSync('products.json', JSON.stringify(finalProducts, null, 2));
  console.log(`Successfully compiled ${finalProducts.length} unique live products into products.json (filtered from ${productsRaw.length} raw entries).`);
}

runSync().catch(err => {
  console.error('SMD Sync Failed:', err);
  process.exit(1);
});
