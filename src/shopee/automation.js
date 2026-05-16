import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { selectors } from './selectors.js';
import { ensureDir, prompt, resolveFromCwd, sleep } from '../utils.js';
import { applyCategoryDefaults, mapAttributesToShopeeFields } from '../extraction/attributeExtractor.js';

export async function runShopeeAutomation({ listing, extracted, rules, config, logger, reviewPaths }) {
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
    await handleAuthGate(page, config, logger);

    await fillFirstMatch(page, selectors.titleInputs, listing.title, 'product title');
    const uploadedImages = await uploadImagesIfEnabled(page, listing, config, logger);
    await waitForManualImagesIfNeeded(uploadedImages, logger);
    await sleep(1500);

    const categoryCandidates = await openAndReadCategoryCandidates(page, logger);
    const selectedCategory = await chooseCategory(page, categoryCandidates, logger);
    await waitAfterCategorySelection(page, selectedCategory, logger);
    await confirmCategoryWithUser(page, logger);
    const confirmedCategoryText = await readSelectedCategoryText(page);
    const extractedWithCategory = applyCategoryDefaults(
      extracted,
      `${selectedCategory?.text || ''} ${confirmedCategoryText}`,
      rules
    );

    await fillDescriptionField(page, listing.description, logger);
    const filledSpecificationAttributes = await fillKnownSpecificationAttributes(page, listing, extractedWithCategory, logger);
    if (listing.price !== '') await fillFirstMatch(page, selectors.priceInputs, String(listing.price), 'price', { optional: true });
    await fillFirstMatch(page, selectors.stockInputs, String(listing.stock), 'stock', { optional: true });
    await fillSalesAndShippingFallbacks(page, listing, logger);

    await sleep(2000);
    const detectedFields = await detectAttributeFields(page);
    const mapped = mapAttributesToShopeeFields(detectedFields, extractedWithCategory);
    const filledAttributes = await fillAttributes(page, mapped.filled, logger);

    const result = {
      categoryCandidates,
      selectedCategory: { ...selectedCategory, confirmedText: confirmedCategoryText },
      uploadedImages,
      detectedFields,
      filledSpecificationAttributes,
      filledAttributes,
      unfilledAttributes: mapped.unfilled,
      reviewPaths
    };

    await logger.info('Shopee draft fields filled. Publish button was not clicked.', result);
    await highlightSubmitButtons(page);
    await logger.screenshot(page, 'before-human-final-review');
    console.log('\nShopee input stopped before publish. Review the browser manually. The publish button was not clicked.');
    console.log('Playwright Inspector is paused. Continue manually only after review.');
    await page.pause();
    return result;
  } catch (error) {
    await logger.screenshot(page, 'shopee-error');
    throw error;
  } finally {
    await context.close();
  }
}

async function handleAuthGate(page, config, logger) {
  await sleep(2000);
  if (await hasVerificationSignal(page)) {
    await logger.warn('Shopee verification or CAPTCHA detected. Waiting for manual handling.');
    console.log('\nShopee verification/CAPTCHA/2FA is visible. Please handle it manually in the browser.');
    await prompt('After finishing verification, press Enter here in PowerShell: ');
  }

  if (await hasLoginSignal(page)) {
    await logger.warn('Shopee login screen detected. Waiting for manual login.');
    console.log('\nShopee login page is open. Please log in manually in the browser.');
    console.log('After Seller Centre is visible, return to this PowerShell window.');
    await prompt('After login is complete, press Enter here: ');
  }

  await page.goto(config.shopee.sellerUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(3000);

  if (await hasVerificationSignal(page)) {
    throw new Error('Shopee CAPTCHA/verification is still visible after manual wait. Stopping without bypass.');
  }
  if (await hasLoginSignal(page)) {
    throw new Error('Shopee login is still required after manual wait. Please complete login and rerun.');
  }
}

async function hasVerificationSignal(page) {
  for (const selector of selectors.blockSignals) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) return true;
  }
  const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  return /captcha|verification|two-step|2fa|verification code/i.test(bodyText);
}

async function hasLoginSignal(page) {
  for (const selector of selectors.loginSignals) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) return true;
  }
  const url = page.url();
  const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  return /login|signin/i.test(url) || /log\s*in|sign\s*in|phone number|username|password/i.test(bodyText);
}

async function fillFirstMatch(page, selectorList, value, label, options = {}) {
  for (const selector of selectorList) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.fill('').catch(() => undefined);
      await locator.fill(value);
      return true;
    }
  }
  if (options.optional) return false;
  throw new Error(`Could not find Shopee ${label} field. Add selector in src/shopee/selectors.js.`);
}

async function uploadImagesIfEnabled(page, listing, config, logger) {
  if (!config.shopee.uploadImages || !listing.imageUrls?.length) {
    await logger.warn('No product image URLs were available for automatic upload.');
    return [];
  }

  const imageFiles = await downloadImages(listing, config, logger);
  if (!imageFiles.length) {
    await logger.warn('No downloadable product images were available. Continuing without image upload.');
    return [];
  }

  const visibleInput = page.locator(selectors.imageInputs.join(',')).first();
  if (await visibleInput.isVisible().catch(() => false)) {
    await visibleInput.setInputFiles(imageFiles);
    return imageFiles;
  }

  for (const selector of selectors.imageUploadTriggers) {
    const trigger = page.locator(selector).first();
    if (!await trigger.isVisible().catch(() => false)) continue;

    try {
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 8000 }),
        trigger.click()
      ]);
      await fileChooser.setFiles(imageFiles);
      return imageFiles;
    } catch (error) {
      await logger.warn('Image trigger did not open a file chooser', { selector, error: error.message });
    }
  }

  const hiddenInput = page.locator(selectors.imageInputs.join(',')).first();
  if (await hiddenInput.count().catch(() => 0)) {
    await hiddenInput.setInputFiles(imageFiles).catch(async (error) => {
      await logger.warn('Hidden image input could not be used', { error: error.message });
    });
    return imageFiles;
  }

  await logger.warn('Image upload control was not found. Continuing without image upload.');
  return [];
}

async function waitForManualImagesIfNeeded(uploadedImages, logger) {
  if (uploadedImages.length > 0) return;
  await logger.warn('Automatic image upload did not complete. Waiting for manual image upload.');
  console.log('\nAutomatic image upload did not complete.');
  console.log('Please add product images manually in the Shopee browser screen.');
  console.log('After images are added, return to this PowerShell window.');
  await prompt('Press Enter here after manual image upload is complete: ');
}

async function downloadImages(listing, config, logger) {
  const imageFiles = [];
  await ensureDir('./downloads');
  for (const [index, url] of listing.imageUrls.slice(0, config.shopee.maxImages).entries()) {
    try {
      if (!/^https?:\/\//i.test(url)) throw new Error('Image URL is not HTTP(S).');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') || 'image/jpeg';
      if (!contentType.startsWith('image/')) throw new Error(`Not an image: ${contentType}`);
      const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
      const file = resolveFromCwd(`./downloads/image-${Date.now()}-${index}.${ext}`);
      await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
      imageFiles.push(file);
    } catch (error) {
      await logger.warn('Failed to download image for upload', { url, error: error.message });
    }
  }
  return imageFiles;
}

async function openAndReadCategoryCandidates(page, logger) {
  for (const selector of selectors.categoryFields) {
    const field = page.locator(selector).first();
    if (!await field.isVisible().catch(() => false)) continue;
    await field.click({ force: true }).catch(() => undefined);
    await sleep(1800);
    const candidates = await readCategoryCandidates(page);
    if (candidates.length) return candidates;
  }

  await logger.warn('No Shopee category candidates detected after clicking category field.');
  console.log('\nNo category candidates were detected automatically. Please select a category manually in the browser if needed.');
  const answer = await prompt('After selecting category manually, press Enter. Press s then Enter to skip: ');
  if (answer.trim().toLowerCase() === 's') return [];
  return [{ index: -1, text: 'Selected manually by user', selector: null, manual: true }];
}

async function readCategoryCandidates(page) {
  for (const selector of selectors.categoryCandidates) {
    const items = page.locator(selector);
    const count = await items.count().catch(() => 0);
    if (count > 0) {
      const candidates = [];
      for (let i = 0; i < Math.min(count, 20); i += 1) {
        const item = items.nth(i);
        if (!await item.isVisible().catch(() => false)) continue;
        const text = await item.innerText().catch(() => '');
        const trimmed = text.replace(/\s+/g, ' ').trim();
        if (trimmed && trimmed.length <= 180) candidates.push({ index: i, text: trimmed, selector });
      }
      if (candidates.length) return dedupeCandidates(candidates);
    }
  }
  return [];
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = candidate.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function chooseCategory(page, candidates, logger) {
  if (!candidates.length) {
    await logger.warn('Category selection skipped because no candidates were available.');
    return null;
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    if (!only.manual) await page.locator(only.selector).nth(only.index).click();
    return only;
  }

  console.log('\nMultiple Shopee category candidates were found.');
  for (let i = 0; i < candidates.length; i += 1) {
    console.log(`${i + 1}. ${candidates[i].text}`);
  }
  const answer = await prompt('Enter the category number to select, or press Enter to choose manually in browser: ');
  const selectedNumber = Number.parseInt(answer, 10);
  if (!Number.isFinite(selectedNumber)) {
    await prompt('Select category manually in the browser, then press Enter here: ');
    return { index: -1, text: 'Selected manually by user', selector: null, manual: true };
  }

  const selected = candidates[selectedNumber - 1];
  if (!selected) {
    await logger.warn('Category selection skipped by user.');
    return null;
  }
  await page.locator(selected.selector).nth(selected.index).click();
  return selected;
}

async function waitAfterCategorySelection(page, selectedCategory, logger) {
  if (!selectedCategory) return;
  await sleep(1500);
  await clickCategoryConfirmIfVisible(page);
  await sleep(3500);
  await logger.info('Category selection step completed', selectedCategory);
}

async function confirmCategoryWithUser(page, logger) {
  await logger.info('Waiting for human category confirmation.');
  console.log('\nPlease confirm the Shopee category in the browser.');
  console.log('If it is wrong, click the edit icon, choose the correct category, and confirm it.');
  console.log('After the category is correct and confirmed, return to PowerShell.');
  await prompt('Press Enter after category confirmation is complete: ');
  await clickCategoryConfirmIfVisible(page);
  await sleep(2500);
}

async function readSelectedCategoryText(page) {
  return page.evaluate(() => {
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const nodes = Array.from(document.querySelectorAll('input, div, span'))
      .filter(isVisible)
      .map((node) => node.value || node.textContent || '')
      .map((text) => String(text).replace(/\s+/g, ' ').trim())
      .filter((text) => text.includes('>') && text.length < 180);
    return nodes[0] || '';
  });
}

async function clickCategoryConfirmIfVisible(page) {
  for (const selector of selectors.categoryConfirmButtons) {
    const button = page.locator(selector).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => undefined);
      break;
    }
  }
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

async function fillKnownSpecificationAttributes(page, listing, extracted, logger) {
  const visibleLabels = await readVisibleSpecificationLabels(page);
  await logger.info('Detected visible specification labels', visibleLabels);
  const defaultPlans = Object.entries(extracted.specificationDefaults || {}).map(([label, value]) => ({
    labels: [label],
    value,
    allowAdd: true,
    search: true,
    source: 'category-default',
    manualReview: false
  }));
  const specificationPlans = Object.entries(listing.specifications || {})
    .filter(([label, value]) => isUsableSpecificationPlan(label, value))
    .map(([label, value]) => ({
      labels: [label],
      value,
      allowAdd: true,
      search: true,
      source: 'tool-specification',
      manualReview: false
    }));
  const plans = [
    { labels: ['Brand'], value: extracted.auto.brand, allowAdd: false, search: true, source: 'amazon' },
    { labels: ['Material'], value: extracted.auto.material, allowAdd: true, search: true, source: 'amazon', manualReview: false },
    { labels: ['Volume Capacity', 'Capacity'], value: extracted.auto.capacity, allowAdd: true, search: true, source: 'amazon', manualReview: false },
    { labels: ['Region of Origin', 'Country of Origin'], value: extracted.auto.countryOfOrigin, allowAdd: true, search: true, source: 'amazon', manualReview: false },
    { labels: ['Color'], value: extracted.auto.color, allowAdd: true, search: true, source: 'amazon', manualReview: false },
    ...defaultPlans,
    ...specificationPlans
  ].filter((plan) => plan.value);

  const filled = [];
  for (const plan of dedupePlans(filterPlansForVisibleLabels(plans, visibleLabels))) {
    const result = await selectSpecificationValue(page, plan, logger);
    if (result.status !== 'skipped') filled.push(result);
  }
  return filled;
}

async function readVisibleSpecificationLabels(page) {
  return page.evaluate(() => {
    const normalize = (text) => String(text || '')
      .replace(/\*/g, '')
      .replace(/\s+\d+\s*\/\s*\d+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const labels = [];
    const controls = Array.from(document.querySelectorAll('input, textarea, [class*="select"], [class*="selector"], [class*="dropdown"]'))
      .filter(isVisible);
    const labelNodes = Array.from(document.querySelectorAll('label, div, span, p'))
      .filter(isVisible)
      .map((node) => ({ node, text: normalize(node.textContent), rect: node.getBoundingClientRect() }))
      .filter((item) => item.text && item.text.length <= 60 && !/please select|input|search/i.test(item.text));

    for (const control of controls) {
      const rect = control.getBoundingClientRect();
      const nearest = labelNodes
        .map((item) => {
          const above = item.rect.bottom <= rect.top + 8 && item.rect.bottom >= rect.top - 90;
          const near = Math.abs(item.rect.left - rect.left) < 120 || (item.rect.left <= rect.left && item.rect.right >= rect.left);
          return { text: item.text, score: (above && near ? 0 : 1000000) + Math.abs(rect.top - item.rect.bottom) * 100 + Math.abs(rect.left - item.rect.left) };
        })
        .sort((a, b) => a.score - b.score)[0];
      if (nearest && nearest.score < 1000000) labels.push(nearest.text);
    }
    return [...new Set(labels)];
  }).catch(() => []);
}

function filterPlansForVisibleLabels(plans, visibleLabels) {
  if (!visibleLabels.length) return plans;
  const expanded = [];
  for (const label of visibleLabels) {
    const value = valueForVisibleSpecificationLabel(label, plans);
    if (!value) continue;
    expanded.push({
      labels: [label],
      value,
      allowAdd: shouldAllowAddForLabel(label),
      search: true,
      source: 'visible-specification',
      manualReview: false
    });
  }
  return expanded;
}

function valueForVisibleSpecificationLabel(label, plans) {
  const lower = String(label || '').toLowerCase();
  const byLabel = (patterns) => plans.find((plan) => patterns.some((pattern) => pattern.test(plan.labels.join(' ').toLowerCase())))?.value;
  const byValue = (patterns) => plans.find((plan) => patterns.some((pattern) => pattern.test(String(plan.value || '').toLowerCase())))?.value;

  if (/brand/.test(lower)) return byLabel([/brand/]);
  if (/sets?\s*&?\s*packages?\s*type|package type|pack type/.test(lower)) return 'Skincare Set';
  if (/application area/.test(lower)) return 'Face';
  if (/skin type/.test(lower)) return byLabel([/skin type/]) || 'All Skin Types';
  if (/formulation/.test(lower)) return byLabel([/formulation/]) || byValue([/lotion|cream|serum|gel|foam|oil/]) || 'Lotion';
  if (/benefit/.test(lower)) return byLabel([/skin care benefits|benefit/]) || byValue([/moistur|bright|soothing|anti-aging|cica/]) || 'Moisturizing';
  if (/ingredient/.test(lower)) return byLabel([/ingredient preference|ingredient/]);
  if (/specialty/.test(lower)) return byLabel([/specialty type/]) || 'Natural';
  if (/volume|capacity/.test(lower)) return byLabel([/volume capacity|capacity/]);
  if (/material/.test(lower)) return byLabel([/material/]);
  if (/color/.test(lower)) return byLabel([/color/]);
  if (/origin/.test(lower)) return byLabel([/origin/]) || 'Japan';
  if (/warranty duration/.test(lower)) return 'No Warranty';
  if (/warranty type/.test(lower)) return 'No Warranty';
  if (/custom product/.test(lower)) return 'No';
  if (/sports product/.test(lower)) return 'No';
  if (/shelf|expiry|expire|expiration/.test(lower)) return '';
  return '';
}

function shouldAllowAddForLabel(label) {
  return !/brand|expiry|expire|shelf/i.test(String(label || ''));
}

function isUsableSpecificationPlan(label, value) {
  const key = String(label || '').trim();
  const text = String(value || '').trim();
  if (!key || !text) return false;
  if (key.length > 80 || text.length > 120) return false;
  if (/shopee tool category|item weight|features/i.test(key)) return false;
  if (/[{}();=]|function|var |window\.|P\.when/i.test(text)) return false;
  return true;
}

function dedupePlans(plans) {
  const seen = new Set();
  const result = [];
  for (const plan of plans) {
    const key = `${plan.labels[0].toLowerCase()}::${String(plan.value).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(plan);
  }
  return result;
}

async function fillDescriptionField(page, description, logger) {
  const value = String(description || '').trim().slice(0, 3000);
  if (!value) {
    await logger.warn('No description text was available.');
    return false;
  }

  await scrollToSection(page, 'Description');

  for (const selector of selectors.descriptionInputs) {
    const locator = page.locator(selector).first();
    if (!await locator.isVisible().catch(() => false)) continue;
    await locator.click({ force: true }).catch(() => undefined);
    await locator.fill('').catch(() => undefined);
    await locator.fill(value).catch(() => undefined);
    if (await verifyDescriptionFilled(page)) {
      await logger.info('Filled product description.');
      return true;
    }
  }

  const filled = await page.evaluate((value) => {
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const setNativeValue = (input, nextValue) => {
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor?.set) descriptor.set.call(input, nextValue);
      else input.value = nextValue;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,div,span,label'))
      .filter((node) => isVisible(node) && /^description$/i.test(String(node.textContent || '').trim()));
    const heading = headings[headings.length - 1];
    const area = heading?.closest('section, [class*="card"], [class*="panel"], [class*="section"], div') || document;
    const input = Array.from(area.querySelectorAll('textarea, [contenteditable="true"]')).find(isVisible)
      || Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).find(isVisible);
    if (!input) return false;
    input.scrollIntoView({ block: 'center' });
    input.focus();
    if (input.isContentEditable) {
      input.textContent = value;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      setNativeValue(input, value);
    }
    return true;
  }, value);

  if (filled && await verifyDescriptionFilled(page)) {
    await logger.info('Filled product description by DOM fallback.');
    return true;
  }

  await logger.warn('Could not fill product description automatically.');
  console.log('\nProduct description could not be filled automatically.');
  console.log('Please paste the description from the review HTML into Shopee.');
  await prompt('Press Enter after handling the description field: ');
  return false;
}

async function scrollToSection(page, sectionName) {
  await page.evaluate((sectionName) => {
    const target = Array.from(document.querySelectorAll('h1,h2,h3,div,span,a'))
      .find((node) => String(node.textContent || '').trim().toLowerCase() === sectionName.toLowerCase());
    target?.scrollIntoView({ block: 'center' });
  }, sectionName).catch(() => undefined);
  await sleep(600);
}

async function verifyDescriptionFilled(page) {
  return page.evaluate(() => {
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    return Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'))
      .filter(isVisible)
      .some((node) => String(node.value || node.textContent || '').trim().length >= 20);
  }).catch(() => false);
}

async function selectSpecificationValue(page, plan, logger) {
  const opened = await openSpecificationDropdown(page, plan.labels);
  if (!opened) {
    await logger.warn('Specification field was not found', { labels: plan.labels, value: plan.value });
    return { ...plan, status: 'skipped', reason: 'field not found' };
  }

  await sleep(800);
  if (plan.search) {
    await typeDropdownSearch(page, plan.value);
    await sleep(900);
  }

  const selected = await clickDropdownOption(page, plan.value);
  if (selected) {
    const verified = await verifySpecificationValue(page, plan.labels, plan.value);
    if (verified) {
      await logger.info('Selected specification attribute', { labels: plan.labels, value: plan.value });
      return { ...plan, status: 'selected' };
    }
    await logger.warn('Specification selection was not reflected in the field', {
      labels: plan.labels,
      value: plan.value
    });
  }

  if (plan.allowAdd) {
    const added = await addDropdownItem(page, plan.value);
    if (added) {
      const verified = await verifySpecificationValue(page, plan.labels, plan.value);
      if (verified) {
        await logger.info('Added specification attribute item', { labels: plan.labels, value: plan.value });
        return { ...plan, status: 'added' };
      }
      await logger.warn('Added specification item was not reflected in the field', {
        labels: plan.labels,
        value: plan.value
      });
    }
  }

  await closeDropdown(page);
  if (plan.manualReview !== false) {
    await waitForManualSpecificationValue(page, plan, logger);
    if (await verifySpecificationValue(page, plan.labels, plan.value)) {
      return { ...plan, status: 'manual' };
    }
  }
  await logger.warn('Specification value needs manual review', {
    labels: plan.labels,
    value: plan.value,
    allowAdd: plan.allowAdd
  });
  return { ...plan, status: 'needs-review' };
}

async function verifySpecificationValue(page, labels, value) {
  return page.evaluate(({ labels, value }) => {
    const normalize = (text) => String(text || '')
      .replace(/\*/g, '')
      .replace(/\s+\d+\s*\/\s*\d+$/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const wantedLabels = labels.map(normalize);
    const wantedValue = normalize(value);
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const labelNodes = Array.from(document.querySelectorAll('label, div, span, p'))
      .filter((node) => isVisible(node) && wantedLabels.includes(normalize(node.textContent)));

    for (const labelNode of labelNodes) {
      const labelRect = labelNode.getBoundingClientRect();
      const visibleNodes = Array.from(document.querySelectorAll('input, textarea, div, span'))
        .filter(isVisible)
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.top >= labelRect.bottom - 12
            && rect.top <= labelRect.bottom + 90
            && Math.abs(rect.left - labelRect.left) < 520;
        });
      const texts = visibleNodes
        .map((node) => node.value || node.textContent || '')
        .map(normalize)
        .filter(Boolean);
      if (texts.some((text) => text.includes(wantedValue) || wantedValue.includes(text))) return true;
    }
    return false;
  }, { labels, value });
}

async function waitForManualSpecificationValue(page, plan, logger) {
  await logger.warn('Waiting for manual specification input', {
    labels: plan.labels,
    value: plan.value
  });
  console.log('\nSpecification could not be filled automatically.');
  console.log(`Field: ${plan.labels.join(' / ')}`);
  console.log(`Value to enter: ${plan.value}`);
  console.log('Please enter/select it manually in the Shopee browser.');
  console.log('If the value is not appropriate for this product, leave it blank.');
  await prompt('Press Enter after handling this specification field: ');
}

async function openSpecificationDropdown(page, labels) {
  const point = await page.evaluate((labels) => {
    const normalize = (text) => String(text || '')
      .replace(/\*/g, '')
      .replace(/\s+\d+\s*\/\s*\d+$/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const wanted = labels.map(normalize);
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const labelNodes = Array.from(document.querySelectorAll('label, div, span, p'))
      .filter((node) => isVisible(node) && wanted.includes(normalize(node.textContent)));

    const clickables = Array.from(document.querySelectorAll('input, [class*="select"], [class*="dropdown"], [class*="selector"], div'))
      .filter((node) => {
        if (!isVisible(node)) return false;
        const text = normalize(node.textContent);
        return node.tagName === 'INPUT' || text.includes('please select') || text.includes('select');
      });

    for (const labelNode of labelNodes) {
      const labelRect = labelNode.getBoundingClientRect();
      const nearest = clickables
        .map((node) => {
          const rect = node.getBoundingClientRect();
          const below = rect.top >= labelRect.bottom - 8;
          const nearColumn = Math.abs(rect.left - labelRect.left) < 180;
          const vertical = Math.max(0, rect.top - labelRect.bottom);
          const horizontal = Math.abs(rect.left - labelRect.left);
          const penalty = below && nearColumn ? 0 : 1000000;
          return { node, score: penalty + vertical * 1000 + horizontal };
        })
        .sort((a, b) => a.score - b.score)[0]?.node;
      if (!nearest) continue;
      nearest.scrollIntoView({ block: 'center' });
      const rect = nearest.getBoundingClientRect();
      return { x: rect.left + rect.width - 24, y: rect.top + rect.height / 2 };
    }
    return null;
  }, labels);
  if (!point) return false;
  await page.mouse.click(point.x, point.y);
  return true;
}

async function typeDropdownSearch(page, value) {
  const searchInputs = page.locator(
    'input[placeholder*="input" i], input[placeholder*="search" i], input[placeholder*="character" i], [class*="popover"] input, [class*="dropdown"] input'
  );
  const count = await searchInputs.count().catch(() => 0);
  for (let i = count - 1; i >= 0; i -= 1) {
    const input = searchInputs.nth(i);
    if (!await input.isVisible().catch(() => false)) continue;
    await input.fill('').catch(() => undefined);
    await input.fill(String(value)).catch(() => undefined);
    return true;
  }
  return false;
}

async function clickDropdownOption(page, value) {
  const normalizedValue = normalizeOption(value);
  const point = await page.evaluate((normalizedValue) => {
    const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const options = Array.from(document.querySelectorAll('[role="option"], li, [class*="option"], [class*="item"]'))
      .filter(isVisible)
      .filter((node) => {
        const text = normalize(node.textContent);
        return text && !text.includes('add a new item') && !text.includes('click here to add your brand');
      });
    const exact = options.find((node) => normalize(node.textContent) === normalizedValue);
    const fuzzy = options.find((node) => {
      const text = normalize(node.textContent);
      return text.includes(normalizedValue) || normalizedValue.includes(text);
    });
    const target = exact || fuzzy;
    if (!target) return null;
    target.scrollIntoView({ block: 'center' });
    const rect = target.getBoundingClientRect();
    return { x: rect.left + Math.min(rect.width / 2, 80), y: rect.top + rect.height / 2 };
  }, normalizedValue);
  if (!point) return false;
  await page.mouse.click(point.x, point.y);
  await sleep(500);
  return true;
}

async function addDropdownItem(page, value) {
  const addPoint = await page.evaluate(() => {
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const candidates = Array.from(document.querySelectorAll('button, div, span, a'))
      .filter(isVisible)
      .filter((node) => /add a new item/i.test(node.textContent || ''));
    const target = candidates[candidates.length - 1];
    if (!target) return null;
    target.scrollIntoView({ block: 'center' });
    const rect = target.getBoundingClientRect();
    return { x: rect.left + Math.min(rect.width / 2, 120), y: rect.top + rect.height / 2 };
  });
  if (!addPoint) return false;
  await page.mouse.click(addPoint.x, addPoint.y);

  await sleep(500);
  const inputs = page.locator('[class*="popover"] input:visible, [class*="dropdown"] input:visible, input:visible');
  const count = await inputs.count().catch(() => 0);
  if (!count) return false;
  const input = inputs.nth(count - 1);
  await input.fill(String(value));
  await input.press('Enter').catch(() => undefined);
  await sleep(300);

  const confirmPoint = await page.evaluate(() => {
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const buttons = Array.from(document.querySelectorAll('button, [class*="confirm"], [class*="check"], span, div'))
      .filter(isVisible);
    const target = buttons.find((node) => /confirm|ok|save/i.test(node.textContent || ''))
      || buttons.find((node) => {
        const rect = node.getBoundingClientRect();
        const text = String(node.textContent || '').trim();
        return text === '' && rect.width <= 60 && rect.height <= 60;
      })
      || buttons[buttons.length - 1];
    if (!target) return null;
    target.scrollIntoView({ block: 'center' });
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  let confirmed = false;
  if (confirmPoint) {
    await page.mouse.click(confirmPoint.x, confirmPoint.y).catch(() => undefined);
    confirmed = true;
  }
  await sleep(600);
  return confirmed || await clickDropdownOption(page, value);
}

async function closeDropdown(page) {
  await page.keyboard.press('Escape').catch(() => undefined);
}

function normalizeOption(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function fillSalesAndShippingFallbacks(page, listing, logger) {
  if (listing.price !== '') {
    await fillInputNearLabel(page, ['Price', 'Original Price'], String(listing.price), logger);
  }
  await fillInputNearLabel(page, ['Stock', 'Available Stock'], String(listing.stock), logger);

  const weightKg = extractWeightKg(listing);
  if (weightKg) {
    await fillInputNearLabel(page, ['Weight'], String(weightKg), logger);
  }
}

async function fillInputNearLabel(page, labels, value, logger) {
  const filled = await page.evaluate(({ labels, value }) => {
    const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const wanted = labels.map(normalize);
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const setValue = (input, nextValue) => {
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor?.set) {
        descriptor.set.call(input, nextValue);
      } else {
        input.value = nextValue;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const labelNodes = Array.from(document.querySelectorAll('label, div, span, p'))
      .filter((node) => {
        const text = normalize(node.textContent);
        return isVisible(node) && wanted.some((label) => text === label || text.startsWith(`${label} `));
      });

    for (const labelNode of labelNodes) {
      const container = labelNode.closest('[class*="form"], [class*="item"], section, div') || labelNode.parentElement;
      const input = container?.querySelector('input:not([disabled]), textarea:not([disabled]), [contenteditable="true"]');
      if (!input) continue;
      input.scrollIntoView({ block: 'center' });
      input.focus();
      if (input.isContentEditable) {
        input.textContent = value;
      } else {
        setValue(input, value);
      }
      return true;
    }

    const inputs = Array.from(document.querySelectorAll('input:not([disabled]), textarea:not([disabled])'))
      .filter(isVisible);
    for (const labelNode of labelNodes) {
      const labelRect = labelNode.getBoundingClientRect();
      const nearest = inputs
        .map((input) => {
          const rect = input.getBoundingClientRect();
          const vertical = Math.max(0, rect.top - labelRect.top);
          const horizontal = Math.abs(rect.left - labelRect.left);
          const penalty = rect.top < labelRect.top - 8 ? 1000000 : 0;
          return { input, score: penalty + vertical * 1000 + horizontal };
        })
        .sort((a, b) => a.score - b.score)[0]?.input;
      if (!nearest) continue;
      nearest.scrollIntoView({ block: 'center' });
      nearest.focus();
      setValue(nearest, value);
      return true;
    }

    return false;
  }, { labels, value });

  if (!filled) {
    await logger.warn('Could not fill field by label fallback', { labels, value });
  }
  return filled;
}

function extractWeightKg(listing) {
  const specs = listing.specifications || {};
  const entry = Object.entries(specs).find(([key]) => /weight/i.test(key));
  const raw = entry?.[1];
  if (!raw) return '';
  const text = String(raw).toLowerCase();
  const number = Number.parseFloat(text.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(number)) return '';
  if (text.includes('kg')) return roundForShopee(number);
  if (text.includes('g')) return roundForShopee(number / 1000);
  return roundForShopee(number);
}

function roundForShopee(value) {
  return Math.round(value * 1000) / 1000;
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

