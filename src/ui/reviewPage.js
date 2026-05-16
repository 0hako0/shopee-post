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
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>Shopee Listing Review - ${escapeHtml(stage)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 32px; color: #1f2937; line-height: 1.5; }
    h1 { font-size: 24px; }
    h2 { margin-top: 28px; font-size: 18px; border-bottom: 1px solid #d1d5db; padding-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { border: 1px solid #d1d5db; padding: 8px; vertical-align: top; text-align: left; }
    th { width: 220px; background: #f3f4f6; }
    img { width: 120px; height: 120px; object-fit: contain; border: 1px solid #d1d5db; margin: 4px; }
    .warn { background: #fff7ed; border: 1px solid #fdba74; padding: 10px; margin: 8px 0; }
    pre { white-space: pre-wrap; background: #f9fafb; border: 1px solid #e5e7eb; padding: 12px; }
  </style>
</head>
<body>
  <h1>Shopee Listing Review: ${escapeHtml(stage)}</h1>
  <h2>基本情報</h2>
  <table>
    ${row('Amazon URL', link(listing.sourceUrl))}
    ${row('商品タイトル', listing.originalTitle)}
    ${row('翻訳後の商品タイトル', listing.title)}
    ${row('価格', listing.price)}
    ${row('在庫数', listing.stock)}
    ${row('商品説明', pre(listing.originalDescription))}
    ${row('翻訳後の商品説明', pre(listing.description))}
  </table>

  <h2>使用する画像</h2>
  <div>${(listing.imageUrls || []).map((url) => `<img src="${escapeAttr(url)}" alt="product image">`).join('') || '画像なし'}</div>

  <h2>属性</h2>
  <table>
    ${row('自動入力候補', pre(JSON.stringify(extracted.auto, null, 2)))}
    ${row('未入力属性', pre(JSON.stringify(extracted.missing, null, 2)))}
    ${row('要確認属性', pre(JSON.stringify(extracted.needsReview, null, 2)))}
  </table>

  <h2>規制カテゴリ警告</h2>
  ${(extracted.warnings || []).map((item) => `<div class="warn"><strong>${escapeHtml(item.name)}</strong><br>${escapeHtml(item.warning)}</div>`).join('') || '警告なし'}

  <h2>Shopeeカテゴリ候補・入力結果</h2>
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
