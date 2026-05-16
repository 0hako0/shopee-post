import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { ensureDir, resolveFromCwd, timestamp } from '../utils.js';

export async function writeReviewPage({ listing, extracted, stage, shopeeResult }) {
  await ensureDir('./output');
  const base = `${timestamp()}-${stage}`;
  const jsonPath = resolveFromCwd(`./output/${base}.json`);
  const htmlPath = resolveFromCwd(`./output/${base}.html`);

  const payload = { stage, listing, extracted, shopeeResult };
  await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  await fs.writeFile(htmlPath, renderHtml(payload), 'utf8');
  openHtml(htmlPath);
  return { jsonPath, htmlPath };
}

function openHtml(htmlPath) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', htmlPath], { detached: true, stdio: 'ignore' }).unref();
  }
}

function renderHtml({ stage, listing, extracted, shopeeResult }) {
  const tool = listing.toolTranslations || listing.rawProduct?.toolTranslations || {};
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>Shopee Listing Review - ${escapeHtml(stage)}</title>
  <style>
    body { font-family: Arial, "Meiryo", sans-serif; margin: 32px; color: #1f2937; line-height: 1.5; }
    h1 { font-size: 24px; }
    h2 { margin-top: 28px; font-size: 18px; border-bottom: 1px solid #d1d5db; padding-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { border: 1px solid #d1d5db; padding: 8px; vertical-align: top; text-align: left; }
    th { width: 240px; background: #f3f4f6; }
    img { width: 120px; height: 120px; object-fit: contain; border: 1px solid #d1d5db; margin: 4px; }
    .warn { background: #fff7ed; border: 1px solid #fdba74; padding: 10px; margin: 8px 0; }
    pre { white-space: pre-wrap; background: #f9fafb; border: 1px solid #e5e7eb; padding: 12px; max-height: 420px; overflow: auto; }
    .muted { color: #6b7280; }
  </style>
</head>
<body>
  <h1>Shopee Listing Review: ${escapeHtml(stage)}</h1>

  <h2>Final Shopee Input</h2>
  <table>
    ${row('Source URL', link(listing.sourceUrl))}
    ${row('Target language', listing.targetLanguage)}
    ${row('Product title to input', listing.title)}
    ${row('Product description to input', pre(listing.description))}
    ${row('Price', listing.price)}
    ${listing.amazonCost ? row('Amazon source price detected', listing.amazonCost) : ''}
    ${row('Pricing source', listing.pricing?.source || '')}
    ${row('Pricing settings', pre(JSON.stringify(listing.pricing || {}, null, 2)))}
    ${listing.priceWarnings?.length ? row('Price warnings', pre(listing.priceWarnings.join('\n'))) : ''}
    ${row('Stock', listing.stock)}
  </table>

  <h2>Shopee Tool Translations</h2>
  <table>
    ${row('Title JA', tool.title_ja || listing.japaneseTitle || '<span class="muted">No Japanese title saved</span>')}
    ${row('Title EN', tool.title_en || '<span class="muted">No English title saved</span>')}
    ${row('Title ZH', tool.title_zh || '<span class="muted">No Chinese title saved</span>')}
    ${row('Description JA', tool.description_ja || listing.japaneseDescription ? pre(tool.description_ja || listing.japaneseDescription) : '<span class="muted">No Japanese description saved</span>')}
    ${row('Description EN', tool.description_en ? pre(tool.description_en) : '<span class="muted">No English description saved</span>')}
    ${row('Description ZH', tool.description_zh ? pre(tool.description_zh) : '<span class="muted">No Chinese description saved</span>')}
  </table>

  <h2>Original Data</h2>
  <table>
    ${row('Japanese product name', listing.japaneseTitle || '')}
    ${row('Original title', listing.originalTitle)}
    ${row('Original description', pre(listing.originalDescription))}
    ${row('Brand', listing.brand)}
    ${row('Model', listing.model)}
  </table>

  <h2>Images</h2>
  <div>${(listing.imageUrls || []).map((url) => `<img src="${escapeAttr(url)}" alt="product image">`).join('') || '<span class="muted">No image URLs detected</span>'}</div>

  <h2>Attributes</h2>
  <table>
    ${row('Auto-filled candidates', pre(JSON.stringify(extracted.auto, null, 2)))}
    ${row('Missing attributes', pre(JSON.stringify(extracted.missing, null, 2)))}
    ${row('Needs review', pre(JSON.stringify(extracted.needsReview, null, 2)))}
  </table>

  <h2>Compliance Warnings</h2>
  ${(extracted.warnings || []).map((item) => `<div class="warn"><strong>${escapeHtml(item.name)}</strong><br>${escapeHtml(item.warning)}</div>`).join('') || '<span class="muted">No warnings</span>'}

  <h2>Shopee Result</h2>
  <pre>${escapeHtml(JSON.stringify(shopeeResult || {}, null, 2))}</pre>
</body>
</html>`;
}

function row(label, value) {
  return `<tr><th>${escapeHtml(label)}</th><td>${value ?? ''}</td></tr>`;
}

function pre(value) {
  return `<pre>${escapeHtml(value || '')}</pre>`;
}

function link(url) {
  return `<a href="${escapeAttr(url)}">${escapeHtml(url)}</a>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#096;');
}
