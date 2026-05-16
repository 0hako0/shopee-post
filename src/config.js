import fs from 'node:fs/promises';
import dotenv from 'dotenv';
import { resolveFromCwd, toNumber } from './utils.js';

dotenv.config();

export async function loadConfig() {
  const defaults = JSON.parse(await fs.readFile(resolveFromCwd('./config/default.json'), 'utf8'));
  return {
    ...defaults,
    shopee: {
      ...defaults.shopee,
      region: process.env.SHOPEE_REGION || defaults.shopee.region,
      sellerUrl: process.env.SHOPEE_SELLER_URL || defaults.shopee.sellerUrl,
      userDataDir: process.env.USER_DATA_DIR || defaults.shopee.userDataDir,
      uploadImages: boolEnv('SHOPEE_UPLOAD_IMAGES', defaults.shopee.uploadImages)
    },
    amazon: {
      ...defaults.amazon,
      source: process.env.AMAZON_SOURCE || defaults.amazon.source,
      manualJsonPath: process.env.AMAZON_MANUAL_JSON || defaults.amazon.manualJsonPath
    },
    listing: {
      ...defaults.listing,
      targetLanguage: process.env.TARGET_LANGUAGE || defaults.listing.targetLanguage,
      defaultStock: toNumber(process.env.DEFAULT_STOCK, defaults.listing.defaultStock),
      priceMarkupPercent: toNumber(process.env.PRICE_MARKUP_PERCENT, defaults.listing.priceMarkupPercent)
    },
    browser: {
      headful: boolEnv('HEADFUL', true),
      slowMoMs: toNumber(process.env.SLOW_MO_MS, 150)
    }
  };
}

function boolEnv(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(process.env[name].toLowerCase());
}
