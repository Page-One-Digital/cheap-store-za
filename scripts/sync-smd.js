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
      // Merge properties into existing entry without duplicating array length
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

  // Fetch fresh raw feeds directly from API
  const [productsRaw, mediaRaw, pricesRaw, stockRaw] = await Promise.all([
    fetchAllPages('products'),
    fetchAllPages('media'),
    fetchAllPages('prices'),
    fetchAllPages('stock')
  ]);

  console.log(`Fetched raw: ${productsRaw.length} products, ${mediaRaw.length} media, ${pricesRaw.length} prices, ${stockRaw.length} stock items.`);

  // 1. Strict SKU Deduplication on raw products (rejects entries without valid SKUs)
  const validProductsRaw = productsRaw.filter(p => p.Sku && String(p.Sku).trim() !== '');
  const uniqueProductsRaw = deduplicateByKey(validProductsRaw, prod => prod.Sku);

  // 2. Map media strictly by SKU (OrderWeight 1 is primary image)
  const mediaMap = {};
  mediaRaw.forEach(item => {
    const sku = item.Sku || item.ProductCode;
    if (!sku || !item.Url) return;
    const cleanSku = normalizeKey(sku);
    if (!mediaMap[cleanSku] || Number(item.OrderWeight) === 1) {
      mediaMap[cleanSku] = item.Url;
    }
  });

  // 3. Map prices strictly by SKU
  const priceMap = {};
  pricesRaw.forEach(item => {
    const sku = item.Sku || item.ProductCode;
    if (!sku) return;
    const cleanSku = normalizeKey(sku);
    const costIncl = parseFloat(item.PriceIncl || 0);
    priceMap[cleanSku] = {
      costIncl,
      rrp: parseFloat(item.PriceRRp || 0)
    };
  });

  // 4. Map stock levels strictly by SKU
  const stockMap = {};
  stockRaw.forEach(item => {
    const sku = item.Sku || item.ProductCode;
    if (!sku) return;
    const cleanSku = normalizeKey(sku);
    stockMap[cleanSku] = parseInt(item.SOH || 0, 10);
  });

  // 5. Build clean catalog objects
  const compiledProducts = uniqueProductsRaw
    .map(prod => {
      const rawSku = String(prod.Sku).trim();
      const lookupSku = normalizeKey(rawSku);

      const priceInfo = priceMap[lookupSku] || { costIncl: 0, rrp: 0 };
      const stockQty = stockMap[lookupSku] ?? 0;
      const imageUrl = mediaMap[lookupSku] || 'https://via.placeholder.com/400?text=No+Image';

      // Apply Cost + 25% Markup
      const retailPrice = priceInfo.costIncl > 0 ? (priceInfo.costIncl * 1.25) : 0;

      return {
        id: rawSku,
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
        extra1: `SKU: ${rawSku}\nBrand: ${prod.Brand || 'N/A'}`
      };
    })
    .filter(p => p.price > 0);

  // 6. Final safety deduplication pass on compiled items
  const finalProducts = deduplicateByKey(compiledProducts, p => p.id);

  // Overwrite products.json directly with fresh unique list
  fs.writeFileSync('products.json', JSON.stringify(finalProducts, null, 2));
  console.log(`Successfully compiled ${finalProducts.length} unique live products into products.json.`);
}

runSync().catch(err => {
  console.error('SMD Sync Failed:', err);
  process.exit(1);
});
