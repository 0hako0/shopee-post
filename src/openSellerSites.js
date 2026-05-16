import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { ensureDir, resolveFromCwd } from './utils.js';

const configPath = process.argv[2] || './config/seller-sites.sample.json';
const sites = JSON.parse(await fs.readFile(resolveFromCwd(configPath), 'utf8'));

for (const site of sites) {
  const userDataDir = resolveFromCwd(site.userDataDir || `./.user-data/shopee-${site.region}`);
  await ensureDir(userDataDir);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 900 }
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto(site.sellerUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  console.log(`Opened ${site.name || site.region}: ${site.sellerUrl}`);
}

console.log('\nAll configured Seller Centre pages are open. Log in manually per country if needed.');
console.log('Keep this process running while you use those browser windows. Press Ctrl+C to close automation contexts.');
await new Promise(() => {});
