import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { selectors } from './selectors.js';
import { ensureDir, prompt, resolveFromCwd, sleep } from '../utils.js';
import { mapAttributesToShopeeFields } from '../extraction/attributeExtractor.js';

export async function runShopeeAutomation({ listing, extracted, config, logger, reviewPaths }) {
  const userDataDir = resolveFromCwd(config.shopee.userDataDir);
  await ensureDir(userDataDir);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    slowMo: config.browser.slowMoMs,
    viewport: { width: 1440, height: 960 }
  });
  const page = context.pages()[0] || await context.newPage();

  try {
    await page.goto(config.shopee.sellerUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await stopOnAuthOrVerification(page, logger);

    await fillFirstMatch(page, selectors.titleInputs, listing.title, 'product title');
    const uploadedImages = await uploadImagesIfEnabled(page, listing, config, logger);
    await sleep(2500);

    const categoryCandidates = await readCategoryCandidates(page);
    const selectedCategory = await chooseCategory(page, categoryCandidates, logger);

    await fillFirstMatch(page, selectors.descriptionInputs, listing.description, 'description', { optional: true });
    if (listing.price !== '') await fillFirstMatch(page, selectors.priceInputs, String(listing.price), 'price', { optional: true });
    await fillFirstMatch(page, selectors.stockInputs, String(listing.stock), 'stock', { optional: true });

    await sleep(2000);
    const detectedFields = await detectAttributeFields(page);
    const mapped = mapAttributesToShopeeFields(detectedFields, extracted);
    const filledAttributes = await fillAttributes(page, mapped.filled, logger);

    const result = {
      categoryCandidates,
      selectedCategory,
      uploadedImages,
      detectedFields,
      filledAttributes,
      unfilledAttributes: mapped.unfilled,
      reviewPaths
    };

    await logger.info('Shopee draft fields filled. Publish button was not clicked.', result);
    await highlightSubmitButtons(page);
    await logger.screenshot(page, 'before-human-final-review');
    console.log('\nShopee入力は投稿直前で停止しました。ブラウザ上で内容を確認してください。投稿ボタンは自動クリックしていません。');
    console.log('Playwright Inspectorで停止します。確認後に手動で操作してください。');
    await page.pause();
    return result;
  } catch (error) {
    await logger.screenshot(page, 'shopee-error');
    throw error;
  } finally {
    await context.close();
  }
}

async function stopOnAuthOrVerification(page, logger) {
  await sleep(2000);
  for (const selector of selectors.blockSignals) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) {
      await logger.warn('Shopee verification or CAPTCHA detected. Stopping without bypass.');
      throw new Error('Shopee CAPTCHA/verification detected. Please handle manually and rerun.');
    }
  }
  for (const selector of selectors.loginSignals) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) {
      await logger.warn('Shopee login screen detected. Stopping so the user can log in manually.');
      throw new Error('Shopee login required. Log in manually using the persistent browser profile, then rerun.');
    }
  }
}

async function fillFirstMatch(page, selectorList, value, label, options = {}) {
  for (const selector of selectorList) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.fill('');
      await locator.fill(value);
      return true;
    }
  }
  if (options.optional) return false;
  throw new Error(`Could not find Shopee ${label} field. Add selector in src/shopee/selectors.js.`);
}

async function uploadImagesIfEnabled(page, listing, config, logger) {
  if (!config.shopee.uploadImages || !listing.imageUrls?.length) return [];
  const input = page.locator(selectors.imageInputs.join(',')).first();
  if (!await input.isVisible().catch(() => false)) {
    await logger.warn('Image file input not found. Continuing without image upload.');
    return [];
  }

  const imageFiles = [];
  await ensureDir('./downloads');
  for (const [index, url] of listing.imageUrls.slice(0, config.shopee.maxImages).entries()) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') || 'image/jpeg';
      const ext = contentType.includes('png') ? 'png' : 'jpg';
      const file = resolveFromCwd(`./downloads/image-${Date.now()}-${index}.${ext}`);
      await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
      imageFiles.push(file);
    } catch (error) {
      await logger.warn('Failed to download image for upload', { url, error: error.message });
    }
  }

  if (imageFiles.length) await input.setInputFiles(imageFiles);
  return imageFiles;
}

async function readCategoryCandidates(page) {
  for (const selector of selectors.categoryCandidates) {
    const items = page.locator(selector);
    const count = await items.count().catch(() => 0);
    if (count > 0) {
      const candidates = [];
      for (let i = 0; i < Math.min(count, 10); i += 1) {
        const text = await items.nth(i).innerText().catch(() => '');
        if (text.trim()) candidates.push({ index: i, text: text.trim(), selector });
      }
      if (candidates.length) return candidates;
    }
  }
  return [];
}

async function chooseCategory(page, candidates, logger) {
  if (!candidates.length) {
    await logger.warn('No Shopee category candidates detected.');
    return null;
  }

  if (candidates.length === 1) {
    await page.locator(candidates[0].selector).nth(candidates[0].index).click();
    return candidates[0];
  }

  console.log('\nShopeeカテゴリ候補が複数あります。');
  for (const candidate of candidates) {
    console.log(`${candidate.index + 1}. ${candidate.text}`);
  }
  const answer = await prompt('選択するカテゴリ番号を入力してください。停止する場合は Enter: ');
  const selectedIndex = Number.parseInt(answer, 10) - 1;
  const selected = candidates.find((candidate) => candidate.index === selectedIndex);
  if (!selected) {
    await logger.warn('Category selection skipped by user.');
    return null;
  }
  await page.locator(selected.selector).nth(selected.index).click();
  return selected;
}

async function detectAttributeFields(page) {
  return page.evaluate((rowSelectors) => {
    const rows = Array.from(document.querySelectorAll(rowSelectors.join(',')));
    return rows.map((row, index) => {
      const label = row.querySelector('label, .label, [class*="label"], [class*="title"]')?.textContent?.trim()
        || row.textContent?.trim()?.split('\n')[0]
        || `attribute_${index + 1}`;
      const input = row.querySelector('input, textarea, [contenteditable="true"]');
      return {
        index,
        label: label.replace(/\s+/g, ' ').slice(0, 120),
        editable: Boolean(input && !input.disabled && !input.readOnly)
      };
    }).filter((field) => field.label);
  }, selectors.attributeRows);
}

async function fillAttributes(page, fields, logger) {
  const filled = [];
  for (const field of fields) {
    const ok = await page.evaluate(({ rowSelectors, fieldIndex, value }) => {
      const rows = Array.from(document.querySelectorAll(rowSelectors.join(',')));
      const row = rows[fieldIndex];
      const input = row?.querySelector('input, textarea, [contenteditable="true"]');
      if (!input) return false;
      input.focus();
      if (input.isContentEditable) {
        input.textContent = value;
      } else {
        input.value = value;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, { rowSelectors: selectors.attributeRows, fieldIndex: field.index, value: field.value });
    if (ok) {
      filled.push(field);
    } else {
      await logger.warn('Failed to fill attribute field', field);
    }
  }
  return filled;
}

async function highlightSubmitButtons(page) {
  for (const selector of selectors.submitButtons) {
    const buttons = page.locator(selector);
    const count = await buttons.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      await buttons.nth(i).evaluate((button) => {
        button.style.outline = '4px solid #d97706';
        button.style.outlineOffset = '3px';
        button.setAttribute('data-codex-note', 'Human must review before clicking.');
      }).catch(() => undefined);
    }
  }
}
