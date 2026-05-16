import { toNumber } from './utils.js';

export function buildListing(product, row, config, translated) {
  const pricing = resolvePricing(product, row, config);
  const sellingPrice = pricing.cost > 0
    ? calculateSellingPrice(pricing.cost, config.listing, pricing)
    : '';

  const bullets = product.bullets?.length ? product.bullets : [];
  const specsText = shouldAppendSpecsToDescription(product)
    ? Object.entries(product.specifications || {})
    .map(([key, value]) => `${key}: ${value}`)
      .join('\n')
    : '';

  return {
    sourceUrl: product.url,
    originalTitle: product.title,
    title: truncate(translated.title || product.title, 120),
    originalDescription: product.description || '',
    description: [translated.description, bullets.join('\n'), specsText]
      .filter(Boolean)
      .join('\n\n')
      .trim(),
    price: sellingPrice,
    stock: toNumber(row.stock, config.listing.defaultStock),
    imageUrls: product.images || [],
    brand: product.brand,
    model: product.model,
    specifications: product.specifications || {},
    rawProduct: product,
    amazonCost: product.amazonCost || '',
    pricing,
    priceWarnings: pricing.warnings,
    toolTranslations: product.toolTranslations || {},
    japaneseTitle: product.shopeeTool?.name || product.toolTranslations?.title_ja || product.title,
    japaneseDescription: product.toolTranslations?.description_ja || '',
    targetLanguage: translated.language
  };
}

function shouldAppendSpecsToDescription(product) {
  return !product.shopeeTool;
}

function resolvePricing(product, row, config) {
  const tool = product.shopeeTool || {};
  const settings = tool.pricingSettings || {};
  const market = String(tool.market || config.shopee?.region || '').toLowerCase();
  const amazonCost = toNumber(product.amazonCost, 0);
  const toolRegisteredPrice = toNumber(tool.sourcePrice, toNumber(product.price, 0));
  const explicitOverride = toNumber(row.priceOverride, 0);
  const cost = explicitOverride || amazonCost || toolRegisteredPrice || 0;
  const warnings = [];

  if (amazonCost > 0 && toolRegisteredPrice > 0) {
    const diffPercent = Math.abs(amazonCost - toolRegisteredPrice) / toolRegisteredPrice * 100;
    if (diffPercent >= 10) {
      warnings.push(`Amazon source price differs from Shopee-tool price by ${Math.round(diffPercent)}% (${amazonCost} vs ${toolRegisteredPrice}).`);
    }
  }

  return {
    market,
    cost,
    amazonCost,
    toolRegisteredPrice,
    targetMarginPercent: toNumber(settings.targetMargin, toNumber(config.listing.targetProfitMarginPercent, 20)),
    feeSettings: settings.feeSettings || {},
    exchangeRate: toNumber(settings.exchangeRates?.[market], 0),
    weightIndex: Number.parseInt(tool.weight, 10),
    shippingByMarket: settings.shippingByMarket || {},
    source: explicitOverride ? 'priceOverride' : amazonCost ? 'amazon' : toolRegisteredPrice ? 'shopee-tool' : 'none',
    warnings
  };
}

function calculateSellingPrice(cost, listingConfig, pricing = {}) {
  const profitMargin = toNumber(pricing.targetMarginPercent, toNumber(listingConfig.targetProfitMarginPercent, 0)) / 100;
  const marketFee = pricing.market ? toNumber(pricing.feeSettings?.[pricing.market], 0) : 0;
  const slsFee = toNumber(pricing.feeSettings?.sls, 0);
  const payoneerFee = toNumber(pricing.feeSettings?.payoneer, 0);
  const platformFee = (marketFee + slsFee + payoneerFee || toNumber(listingConfig.platformFeePercent, 0)) / 100;
  const shipping = shippingCostForPricing(pricing);
  const totalRate = profitMargin + platformFee;

  if (totalRate > 0 && totalRate < 1) {
    const jpyPrice = (cost + shipping) / (1 - totalRate);
    const localPrice = pricing.exchangeRate > 0 ? jpyPrice * pricing.exchangeRate : jpyPrice;
    return roundMarketPrice(localPrice, pricing.market);
  }

  const markup = toNumber(listingConfig.priceMarkupPercent, 0) / 100;
  return roundMoney(cost * (1 + markup));
}

function shippingCostForPricing(pricing) {
  const table = pricing.shippingByMarket?.[pricing.market];
  if (!Array.isArray(table)) return 0;
  const value = table[Number.isInteger(pricing.weightIndex) ? pricing.weightIndex : 2];
  return toNumber(value, 0);
}

function roundMarketPrice(value, market) {
  if (market === 'vn') return Math.round(value / 1000) * 1000;
  if (market === 'tw' || market === 'th' || market === 'ph') return Math.ceil(value);
  return Math.round(value * 100) / 100;
}

function truncate(value, max) {
  const text = String(value || '').trim();
  return text.length > max ? text.slice(0, max - 1).trim() : text;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}
