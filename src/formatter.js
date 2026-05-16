import { toNumber } from './utils.js';

export function buildListing(product, row, config, translated) {
  const basePrice = toNumber(row.priceOverride, product.price || 0);
  const markedUpPrice = basePrice > 0
    ? roundMoney(basePrice * (1 + config.listing.priceMarkupPercent / 100))
    : '';

  const bullets = product.bullets?.length ? product.bullets : [];
  const specsText = Object.entries(product.specifications || {})
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');

  return {
    sourceUrl: product.url,
    originalTitle: product.title,
    title: truncate(translated.title || product.title, 120),
    originalDescription: product.description || '',
    description: [translated.description, bullets.join('\n'), specsText]
      .filter(Boolean)
      .join('\n\n')
      .trim(),
    price: markedUpPrice,
    stock: toNumber(row.stock, config.listing.defaultStock),
    imageUrls: product.images || [],
    brand: product.brand,
    model: product.model,
    specifications: product.specifications || {},
    rawProduct: product,
    targetLanguage: translated.language
  };
}

function truncate(value, max) {
  const text = String(value || '').trim();
  return text.length > max ? text.slice(0, max - 1).trim() : text;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}
