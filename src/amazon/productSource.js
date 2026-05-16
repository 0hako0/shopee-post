import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { resolveFromCwd, sleep, toNumber } from '../utils.js';

export async function fetchProduct(row, config, logger) {
  if (!row.amazonUrl) throw new Error('Missing amazonUrl');

  if (row.productFromTool) {
    return fetchFromShopeeTool(row, config, logger);
  }

  if (config.amazon.source === 'manual-json') {
    return fetchFromManualJson(row.amazonUrl, config);
  }

  if (config.amazon.source === 'paapi') {
    throw new Error('PA-API adapter is a placeholder in this MVP. Set AMAZON_SOURCE=manual-json or playwright.');
  }

  return fetchWithPlaywright(row.amazonUrl, config, logger);
}

async function fetchFromShopeeTool(row, config, logger) {
  const product = normalizeProduct(row.productFromTool);
  if (!/^https?:\/\//i.test(row.amazonUrl)) return product;

  try {
    const amazonProduct = await fetchWithPlaywright(row.amazonUrl, config, logger);
    const amazonCost = toNumber(amazonProduct.price, 0);
    const sourcePrice = toNumber(product.shopeeTool?.sourcePrice, product.price || 0);
    if (amazonCost > 0) {
      await logger.info('Fetched Amazon source price for Shopee tool product.', {
        amazonUrl: row.amazonUrl,
        amazonCost,
        currentShopeeToolPrice: sourcePrice
      });
    }
    return normalizeProduct({
      ...product,
      amazonCost: amazonCost || product.amazonCost,
      price: amazonCost || product.price,
      images: amazonProduct.images || [],
      specifications: {
        ...amazonProduct.specifications,
        ...product.specifications
      }
    });
  } catch (error) {
    await logger.warn('Could not fetch Amazon images for Shopee tool product. Continuing with text data only.', {
      amazonUrl: row.amazonUrl,
      error: error.message
    });
    return product;
  }
}

async function fetchFromManualJson(url, config) {
  const products = JSON.parse(await fs.readFile(resolveFromCwd(config.amazon.manualJsonPath), 'utf8'));
  const product = products.find((item) => item.url === url || url.includes(extractAsin(item.url)));
  if (!product) throw new Error(`Product not found in manual JSON: ${url}`);
  return normalizeProduct({ ...product, url });
}

async function fetchWithPlaywright(url, config, logger) {
  await logger.warn('Using Playwright fallback for Amazon. Prefer PA-API or manual-json for production compliance.');
  const browser = await chromium.launch({
    headless: !config.browser.headful,
    slowMo: config.browser.slowMoMs
  });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(config.amazon.slowDownMs);
    await stopIfAmazonBlocked(page);

    const product = await page.evaluate(() => {
      const text = (selector) => document.querySelector(selector)?.textContent?.trim() || '';
      const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name) || '';
      const title = text('#productTitle') || text('span#title') || document.title;
      const priceText = text('.a-price .a-offscreen') || text('#priceblock_ourprice') || text('#priceblock_dealprice');
      const brand = text('#bylineInfo') || text('tr.po-brand td:nth-child(2)');
      const bullets = Array.from(document.querySelectorAll('#feature-bullets li span'))
        .map((node) => node.textContent.trim())
        .filter(Boolean);
      const description = text('#productDescription') || bullets.join('\n');
      const landingImage = document.querySelector('#landingImage, #imgBlkFront');
      let dynamicImages = [];
      try {
        dynamicImages = Object.keys(JSON.parse(landingImage?.getAttribute('data-a-dynamic-image') || '{}'));
      } catch {
        dynamicImages = [];
      }
      const mainImage = attr('#landingImage', 'src')
        || attr('#imgBlkFront', 'src')
        || attr('meta[property="og:image"]', 'content')
        || attr('link[rel="image_src"]', 'href');
      const images = Array.from(new Set([
        mainImage,
        ...dynamicImages,
        ...Array.from(document.querySelectorAll('#altImages img')).map((img) => img.src)
      ].filter(Boolean)
        .map((src) => src.replace(/\._[A-Z0-9_,]+_\./i, '.'))
        .filter((src) => !src.includes('transparent-pixel'))));
      const specifications = {};
      for (const row of document.querySelectorAll('#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, table.a-keyvalue tr')) {
        const key = row.querySelector('th, .a-text-bold')?.textContent?.replace(/\s+/g, ' ').trim();
        const value = row.querySelector('td, span:not(.a-text-bold)')?.textContent?.replace(/\s+/g, ' ').trim();
        if (key && value) specifications[key.replace(/:$/, '')] = value;
      }
      for (const item of document.querySelectorAll('#detailBullets_feature_div li')) {
        const raw = item.textContent.replace(/\s+/g, ' ').trim();
        const parts = raw.split(':');
        if (parts.length >= 2) specifications[parts[0].trim()] = parts.slice(1).join(':').trim();
      }
      return { title, priceText, brand, bullets, description, images, specifications };
    });

    return normalizeProduct({
      url,
      title: product.title,
      price: toNumber(product.priceText, 0),
      brand: cleanBrand(product.brand),
      model: findSpec(product.specifications, ['Model', 'Item model number', '型番']),
      description: product.description,
      bullets: product.bullets,
      images: product.images,
      specifications: product.specifications
    });
  } catch (error) {
    await logger.screenshot(page, 'amazon-error');
    throw error;
  } finally {
    await browser.close();
  }
}

async function stopIfAmazonBlocked(page) {
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  if (/captcha|enter the characters|robot check|sign in|two-step verification/i.test(bodyText)) {
    throw new Error('Amazon showed CAPTCHA/login/verification. Stopping without bypass.');
  }
}

function normalizeProduct(product) {
  const descriptionForListing = [
    product.description,
    ...(product.bullets || [])
  ].filter(Boolean).join('\n');
  return {
    ...product,
    title: product.title || 'Untitled product',
    descriptionForListing,
    specifications: product.specifications || {},
    images: product.images || []
  };
}

function cleanBrand(brand) {
  return String(brand || '').replace(/^Brand:\s*/i, '').replace(/^Visit the\s+/i, '').replace(/\s+Store$/i, '').trim();
}

function findSpec(specs, names) {
  const entries = Object.entries(specs || {});
  const found = entries.find(([key]) => names.some((name) => key.toLowerCase().includes(name.toLowerCase())));
  return found?.[1] || '';
}

function extractAsin(url = '') {
  return url.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || '';
}
