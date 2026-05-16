import { readInputRows } from './csv.js';
import { loadConfig } from './config.js';
import { Logger } from './logger.js';
import { fetchProduct } from './amazon/productSource.js';
import { Translator } from './translator.js';
import { buildListing } from './formatter.js';
import { extractAttributes, loadRules } from './extraction/attributeExtractor.js';
import { writeReviewPage } from './ui/reviewPage.js';
import { runShopeeAutomation } from './shopee/automation.js';
import { prompt } from './utils.js';
import {
  applyProcessedStatus,
  loadProcessedProducts,
  markProcessed,
  processedKey,
  shouldUseProcessedFilter,
  splitProcessedRows
} from './processedProducts.js';

async function main() {
  const args = process.argv.slice(2);
  const logger = new Logger();
  await logger.init();
  const config = await loadConfig();
  const rules = await loadRules(config);
  const processed = await loadProcessedProducts(args);
  const allRows = applyProcessedStatus(await readInputRows(args, { processed }), processed);
  const { rows, skippedRows } = filterRows(allRows, processed);
  const translator = new Translator({ targetLanguage: config.listing.targetLanguage });

  await logger.info('Started run', {
    rows: rows.length,
    totalRows: allRows.length,
    skippedProcessed: skippedRows.length,
    amazonSource: config.amazon.source
  });
  if (skippedRows.length) {
    await logger.info(`Skipped ${skippedRows.length} already processed product(s).`);
  }
  if (!rows.length) {
    await logger.info('No unprocessed products to run.');
  }

  for (const [index, row] of rows.entries()) {
    await logger.info(`Processing row ${index + 1}`, row);
    try {
      const product = await fetchProduct(row, config, logger);
      const translated = await translator.translateProduct(product, row.targetLanguage);
      const listing = buildListing(product, row, config, translated);
      const extracted = extractAttributes(listing, rules);

      const beforeReview = await writeReviewPage({ listing, extracted, stage: 'before-shopee-input' });
      await logger.info('Before-input review created', beforeReview);
      const answer = await prompt('\nReview HTML was opened. Enter y to start Shopee input: ');
      if (answer.toLowerCase() !== 'y') {
        await logger.warn('User skipped Shopee input for this row.');
        continue;
      }

      const shopeeResult = await runShopeeAutomation({
        listing,
        extracted,
        rules,
        config,
        logger,
        reviewPaths: beforeReview
      });

      const afterReview = await writeReviewPage({
        listing,
        extracted: {
          ...extracted,
          autoFilledOnShopee: shopeeResult.filledAttributes,
          unfilledOnShopee: shopeeResult.unfilledAttributes
        },
        stage: 'after-shopee-input',
        shopeeResult
      });
      await logger.info('After-input review created', afterReview);

      await askAndMarkProcessed(row, processed, logger);
    } catch (error) {
      await logger.error('Row failed', { row, error: error.stack || error.message });
    }
  }

  await logger.info('Run finished');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function filterRows(rows, processed) {
  if (!shouldUseProcessedFilter(rows, processed)) {
    return { rows, skippedRows: [] };
  }

  const { active, skipped } = splitProcessedRows(rows, processed);
  return { rows: active, skippedRows: skipped };
}

async function askAndMarkProcessed(row, processed, logger) {
  const key = processedKey(row);
  if (!key) return;

  const answer = await prompt(`\nMark this product as processed for ${key.market}? Enter y to mark, or press Enter to leave unprocessed: `);
  if (answer.toLowerCase() !== 'y') {
    await logger.warn('Product was not marked as processed.', key);
    return;
  }

  await markProcessed(row, processed);
  await logger.info('Product marked as processed.', key);
}


