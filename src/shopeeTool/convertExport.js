import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_JSON_OUT = './data/manual-products.from-shopee-tool.json';
const DEFAULT_CSV_OUT = './data/input.from-shopee-tool.csv';

async function main() {
  const args = process.argv.slice(2);
  const jsonPath = getArg(args, '--json');
  if (!jsonPath) {
    throw new Error('Missing --json. Example: npm run convert:shopee-tool -- --json ./data/shopee-export.json');
  }

  const language = normalizeLanguage(getArg(args, '--language') || 'en');
  const market = String(getArg(args, '--market') || 'sg').toLowerCase();
  const stock = getArg(args, '--stock') || '5';
  const productsOut = getArg(args, '--out-products') || DEFAULT_JSON_OUT;
  const csvOut = getArg(args, '--out-csv') || DEFAULT_CSV_OUT;

  const payload = JSON.parse(stripBom(await fs.readFile(resolveFromCwd(jsonPath), 'utf8')));
  const products = Array.isArray(payload.products) ? payload.products : [];
  const descriptions = payload.descriptions || {};
  const pricingSettings = normalizePricingSettings(payload);

  if (!products.length) {
    throw new Error('No products found in Shopee tool JSON export.');
  }

  const convertedProducts = products.map((product) => {
    const desc = descriptions[`desc_${product.id}`] || {};
    return convertProduct(product, desc, { language, market, pricingSettings });
  });

  const rows = convertedProducts.map((product) => ({
    amazonUrl: product.url,
    stock,
    priceOverride: '',
    targetLanguage: language
  }));

  await writeJson(productsOut, convertedProducts);
  await writeText(csvOut, toCsv(rows));

  console.log(`Converted ${convertedProducts.length} product(s).`);
  console.log(`Manual JSON: ${productsOut}`);
  console.log(`CSV: ${csvOut}`);
  console.log('');
  console.log('Next: set AMAZON_MANUAL_JSON in .env to the Manual JSON path, then run:');
  console.log(`npm start -- --csv ${csvOut}`);
}

function convertProduct(product, desc, options) {
  const title = pickTitle(product, desc, options.language);
  const description = pickDescription(product, desc, options.language);
  const supplierUrl = firstSupplierUrl(product) || `shopee-tool:${product.id}`;
  const price = pickPrice(product, options.market);
  const weightKg = weightIndexToKg(product.weight);
  const specs = buildSpecifications(product, desc, weightKg);

  return {
    url: supplierUrl,
    title,
    price,
    currency: 'SOURCE',
    brand: cleanValue(desc.brand),
    model: '',
    description,
    bullets: splitLines(desc.features),
    images: [],
    specifications: specs,
    shopeeTool: {
      id: product.id,
      name: product.name,
      category: product.category || '',
      market: options.market,
      weight: product.weight,
      sourcePrice: price,
      supplierUrls: normalizeSupplierUrls(product.supplier_urls),
      pricingSettings: options.pricingSettings || {}
    }
  };
}

function normalizePricingSettings(payload) {
  const source = payload.pricing_settings || {};
  return {
    targetMargin: toNumber(source.target_margin, toNumber(payload.target_margin, 20)),
    feeSettings: source.fee_settings || payload.fee_settings || {},
    exchangeRates: source.exchange_rates || payload.exchange_rates || {},
    shippingByMarket: source.shipping_by_market || {},
    currencyUnits: source.currency_units || {}
  };
}

function pickTitle(product, desc, language) {
  return cleanValue(desc[`title_${language}`])
    || cleanValue(desc.title_en)
    || cleanValue(desc.title_zh)
    || cleanValue(product.name)
    || 'Untitled product';
}

function pickDescription(product, desc, language) {
  return cleanValue(desc[language])
    || cleanValue(desc.en)
    || cleanValue(desc.zh)
    || cleanValue(desc.ja)
    || cleanValue(product.name)
    || '';
}

function pickPrice(product, market) {
  const marketPrice = product.markets?.[market]?.price;
  const fallback = product.cost;
  return toNumber(marketPrice, toNumber(fallback, 0));
}

function buildSpecifications(product, desc, weightKg) {
  const specs = {};
  addSpec(specs, 'Brand', desc.brand);
  addSpec(specs, 'Material', desc.material);
  addSpec(specs, 'Features', desc.features);
  addSpec(specs, 'Shopee Tool Category', product.category);
  addSpec(specs, 'Item Weight', weightKg ? `${weightKg}kg` : '');

  for (const [key, value] of Object.entries(desc.spec_fields || {})) {
    addSpec(specs, labelizeSpecKey(key), value);
  }

  return specs;
}

function labelizeSpecKey(key) {
  const labels = {
    formulation: 'Formulation',
    skin_type: 'Skin Type',
    skin_care_benefits: 'Skin Care Benefits',
    ingredient_preference: 'Ingredient Preference',
    specialty_type: 'Specialty Type',
    volume_ml: 'Volume Capacity',
    quantity: 'Quantity',
    ingredient: 'Ingredient',
    shelf_life: 'Shelf Life',
    material_detail: 'Material',
    color: 'Color',
    size_detail: 'Size',
    age_range: 'Age Range'
  };
  return labels[key] || String(key).replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function firstSupplierUrl(product) {
  const urls = normalizeSupplierUrls(product.supplier_urls);
  return urls.find((url) => /^https?:\/\//i.test(url)) || '';
}

function normalizeSupplierUrls(value) {
  if (Array.isArray(value)) return value.map(cleanValue).filter(Boolean);
  if (typeof value === 'string') return splitLines(value);
  return [];
}

function weightIndexToKg(value) {
  const weights = ['0.08', '0.2', '0.4', '0.8', '1.5'];
  const index = Number.parseInt(value, 10);
  return weights[index] || cleanValue(value);
}

function splitLines(value) {
  return String(value ?? '')
    .split(/\r?\n|[;]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function addSpec(specs, key, value) {
  const cleaned = cleanValue(value);
  if (key && cleaned) specs[key] = cleaned;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

async function writeJson(filePath, data) {
  const resolved = resolveFromCwd(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function writeText(filePath, data) {
  const resolved = resolveFromCwd(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, data, 'utf8');
}

function getArg(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}

function normalizeLanguage(value) {
  const language = String(value || '').toLowerCase();
  if (['en', 'zh', 'th', 'vn'].includes(language)) return language;
  return 'en';
}

function cleanValue(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).replace(/[^\d.-]/g, '');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stripBom(text) {
  return text.replace(/^\uFEFF/, '');
}

function resolveFromCwd(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
