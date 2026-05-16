import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { prompt, resolveFromCwd } from '../utils.js';

export async function readShopeeToolRows(args, options = {}) {
  const jsonPath = getArg(args, '--shopee-tool-json');
  const useLiveStorage = args.includes('--shopee-tool-live');
  if (!jsonPath && !useLiveStorage) return null;

  const language = normalizeLanguage(getArg(args, '--language') || getArg(args, '--target-language') || process.env.TARGET_LANGUAGE || 'en');
  const market = String(getArg(args, '--market') || process.env.SHOPEE_REGION || 'sg').toLowerCase();
  const stock = getArg(args, '--stock') || process.env.DEFAULT_STOCK || '5';

  const payload = useLiveStorage
    ? await readShopeeToolLocalStorage(args)
    : JSON.parse(stripBom(await fs.readFile(await resolveShopeeToolJsonPath(jsonPath), 'utf8')));
  const products = Array.isArray(payload.products) ? payload.products : [];
  const descriptions = payload.descriptions || {};
  const pricingSettings = normalizePricingSettings(payload);

  if (!products.length) {
    throw new Error(`No products found in Shopee tool JSON: ${jsonPath}`);
  }

  const rows = products.map((product) => {
    const desc = descriptions[`desc_${product.id}`] || {};
    const converted = convertShopeeToolProduct(product, desc, { language, market, pricingSettings });
    return {
      amazonUrl: converted.url,
      stock,
      priceOverride: '',
      targetLanguage: language,
      productFromTool: converted
    };
  });

  return selectRowsIfRequested(rows, args, { products, descriptions, market, processed: options.processed });
}

async function readShopeeToolLocalStorage(args) {
  const toolUrl = getArg(args, '--shopee-tool-url') || 'https://0hako0.github.io/Shopee-tool-ver2.0/';
  const userDataDir = getArg(args, '--tool-user-data-dir') || './.user-data/shopee-tool';
  const context = await chromium.launchPersistentContext(resolveFromCwd(userDataDir), {
    headless: false,
    viewport: { width: 1400, height: 900 }
  });
  const page = await context.newPage();

  try {
    await page.goto(toolUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('\nShopee-tool browser opened.');
    console.log('If your products are not visible there, import/open your data in this browser first.');
    await prompt('After the product list and generated descriptions are visible, press Enter here: ');

    const payload = await page.evaluate(() => {
      const products = JSON.parse(localStorage.getItem('shopee_products') || '[]');
      const descriptions = {};
      const shipping = {};

      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('desc_')) {
          try {
            descriptions[key] = JSON.parse(localStorage.getItem(key) || '{}');
          } catch {
            descriptions[key] = {};
          }
        }
        if (key.startsWith('shipping_')) {
          try {
            shipping[key] = JSON.parse(localStorage.getItem(key) || '{}');
          } catch {
            shipping[key] = {};
          }
        }
      }

      return {
        version: 1,
        source: 'localStorage',
        exported_at: new Date().toISOString(),
        products,
        descriptions,
        shipping,
        pricing_settings: {
          fee_settings: JSON.parse(localStorage.getItem('fee_settings') || '{}'),
          target_margin: localStorage.getItem('target_margin') || '',
          exchange_rates: typeof exchangeRates === 'object' ? exchangeRates : {},
          shipping_by_market: typeof shippingByMarket === 'object' ? shippingByMarket : {}
        },
        fee_settings: JSON.parse(localStorage.getItem('fee_settings') || '{}'),
        target_margin: localStorage.getItem('target_margin') || ''
      };
    });

    if (!payload.products?.length) {
      throw new Error('No products were found in Shopee-tool localStorage in the Playwright browser.');
    }

    return payload;
  } finally {
    await context.close();
  }
}

async function resolveShopeeToolJsonPath(jsonPath) {
  if (String(jsonPath).toLowerCase() !== 'latest') return resolveFromCwd(jsonPath);

  const candidates = [
    path.resolve(process.cwd(), 'data'),
    path.resolve(os.homedir(), 'Downloads')
  ];
  const files = [];

  for (const dir of candidates) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
      if (isInternalOrSampleJson(entry.name)) continue;
      const file = path.join(dir, entry.name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat) files.push({ file, mtimeMs: stat.mtimeMs });
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of files) {
    if (await looksLikeShopeeToolExport(candidate.file)) return candidate.file;
  }

  throw new Error('Could not find latest Shopee tool JSON export in ./data or Downloads.');
}

function isInternalOrSampleJson(fileName) {
  const normalized = fileName.toLowerCase();
  return normalized.includes('.sample.')
    || normalized.includes('sample')
    || normalized.includes('processed-products')
    || normalized.includes('manual-products')
    || normalized.includes('input.from-shopee-tool')
    || normalized.includes('converted');
}

async function looksLikeShopeeToolExport(filePath) {
  try {
    const text = stripBom(await fs.readFile(filePath, 'utf8'));
    const payload = JSON.parse(text);
    return Array.isArray(payload.products) && payload.descriptions && typeof payload.descriptions === 'object';
  } catch {
    return false;
  }
}

export function convertShopeeToolProduct(product, desc, options) {
  const title = pickTitle(product, desc, options.language);
  const description = pickDescription(product, desc, options.language);
  const supplierUrl = firstSupplierUrl(product) || `shopee-tool:${product.id}`;
  const price = pickPrice(product, options.market);
  const weightKg = weightIndexToKg(product.weight);
  const specs = buildSpecifications(product, desc, weightKg);
  const toolTranslations = buildToolTranslations(desc);

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
    toolTranslations,
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

function buildToolTranslations(desc) {
  return {
    title_en: cleanValue(desc.title_en),
    title_zh: cleanValue(desc.title_zh),
    title_ja: cleanValue(desc.title_ja),
    description_en: buildListingDescription(desc, 'en'),
    description_zh: buildListingDescription(desc, 'zh'),
    description_ja: buildListingDescription(desc, 'ja')
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
  const languageDescription = buildListingDescription(desc, language);
  if (languageDescription) return languageDescription;

  return buildListingDescription(desc, 'en')
    || buildListingDescription(desc, 'zh')
    || buildListingDescription(desc, 'ja')
    || cleanValue(product.name)
    || '';
}

function buildListingDescription(desc, language) {
  const sections = [
    cleanValue(desc[language]),
    cleanValue(desc[`catchcopy_${language}`]),
    cleanValue(desc[`features_${language}`] || desc.features),
    cleanValue(desc[`uses_${language}`]),
    cleanValue(desc[`target_${language}`]),
    cleanValue(desc[`steps_${language}`]),
    cleanValue(desc[`warnings_${language}`])
  ].filter(Boolean);

  return [...new Set(sections)].join('\n\n').trim();
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
  if (Array.isArray(value)) return value.map(normalizeSupplierUrl).filter(Boolean);
  if (typeof value === 'string') return splitLines(value);
  if (value && typeof value === 'object') return [normalizeSupplierUrl(value)].filter(Boolean);
  return [];
}

function normalizeSupplierUrl(value) {
  if (typeof value === 'string') return cleanValue(value);
  if (value && typeof value === 'object') return cleanValue(value.url || value.href || value.link);
  return '';
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

function getArg(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}

async function selectRowsIfRequested(rows, args, context) {
  const idsArg = getArg(args, '--ids');
  if (idsArg) return selectRowsByTokens(rows, idsArg);

  if (!args.includes('--select-products')) return rows;

  printProductList(rows, context);
  const answer = await prompt('\nEnter product numbers or IDs to list. Example: 1,3,5-7. Press Enter to cancel: ');
  if (!answer.trim()) return [];

  return selectRowsByTokens(rows, answer);
}

function printProductList(rows, context = {}) {
  console.log('\nProducts in Shopee tool JSON:');
  rows.forEach((row, index) => {
    const tool = row.productFromTool?.shopeeTool || {};
    const raw = context.products?.find((product) => String(product.id) === String(tool.id)) || {};
    const desc = context.descriptions?.[`desc_${tool.id}`] || {};
    const title = row.productFromTool?.title || tool.name || row.amazonUrl;
    const originalName = raw.name && raw.name !== title ? ` / original: ${raw.name}` : '';
    const category = raw.category ? ` / category: ${raw.category}` : '';
    const price = row.productFromTool?.price ? ` / ${context.market || tool.market}: ${row.productFromTool.price}` : '';
    const brand = desc.brand ? ` / brand: ${desc.brand}` : '';
    const url = row.amazonUrl && /^https?:\/\//i.test(row.amazonUrl) ? ` / URL: ${shortUrl(row.amazonUrl)}` : '';
    const translated = translatedSummary(desc);
    const status = isAlreadyProcessed(row, context.processed) ? 'DONE / ' : '';
    const translationStatus = translated ? '' : ' / NO TOOL TRANSLATION';

    console.log(`${index + 1}. ${status}[${tool.id || '-'}] ${title}${originalName}${brand}${category}${price}${url}${translationStatus}`);
    if (translated) console.log(`   ${translated}`);
  });
}

function isAlreadyProcessed(row, processed) {
  if (!processed?.data) return false;
  const tool = row.productFromTool?.shopeeTool;
  if (!tool?.id) return false;
  const market = String(tool.market || 'default').toLowerCase();
  return (processed.data[market] || []).some((item) => String(item.id) === String(tool.id));
}

function translatedSummary(desc) {
  const parts = [];
  if (desc.title_en) parts.push(`EN: ${truncate(desc.title_en, 80)}`);
  if (desc.title_zh) parts.push(`ZH: ${truncate(desc.title_zh, 80)}`);
  return parts.join(' / ');
}

function shortUrl(url) {
  return String(url).replace(/^https?:\/\/(www\.)?/i, '').slice(0, 90);
}

function truncate(value, max) {
  const text = String(value || '').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function selectRowsByTokens(rows, input) {
  const selectedIndexes = new Set();
  const byId = new Map(rows.map((row, index) => [String(row.productFromTool?.shopeeTool?.id || ''), index]));

  for (const token of String(input).split(',')) {
    const trimmed = token.trim();
    if (!trimmed) continue;

    const range = trimmed.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number.parseInt(range[1], 10);
      const end = Number.parseInt(range[2], 10);
      for (let number = Math.min(start, end); number <= Math.max(start, end); number += 1) {
        addSelection(rows, byId, selectedIndexes, String(number));
      }
      continue;
    }

    addSelection(rows, byId, selectedIndexes, trimmed);
  }

  return [...selectedIndexes].sort((a, b) => a - b).map((index) => rows[index]);
}

function addSelection(rows, byId, selectedIndexes, token) {
  const number = Number.parseInt(token, 10);
  if (Number.isInteger(number) && String(number) === token && number >= 1 && number <= rows.length) {
    selectedIndexes.add(number - 1);
    return;
  }

  if (byId.has(token)) selectedIndexes.add(byId.get(token));
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

export function outputPathForShopeeToolJson(jsonPath) {
  const parsed = path.parse(jsonPath);
  return `./data/${parsed.name}.converted.json`;
}
