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

async function main() {
  const logger = new Logger();
  await logger.init();
  const config = await loadConfig();
  const rules = await loadRules(config);
  const rows = await readInputRows(process.argv.slice(2));
  const translator = new Translator({ targetLanguage: config.listing.targetLanguage });

  await logger.info('Started run', { rows: rows.length, amazonSource: config.amazon.source });

  for (const [index, row] of rows.entries()) {
    await logger.info(`Processing row ${index + 1}`, row);
    try {
      const product = await fetchProduct(row, config, logger);
      const translated = await translator.translateProduct(product, row.targetLanguage);
      const listing = buildListing(product, row, config, translated);
      const extracted = extractAttributes(listing, rules);

      const beforeReview = await writeReviewPage({ listing, extracted, stage: 'before-shopee-input' });
      await logger.info('Before-input review created', beforeReview);
      const answer = await prompt('\n確認HTMLを開きました。Shopeeへ入力を開始する場合は y を入力してください: ');
      if (answer.toLowerCase() !== 'y') {
        await logger.warn('User skipped Shopee input for this row.');
        continue;
      }

      const shopeeResult = await runShopeeAutomation({
        listing,
        extracted,
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
