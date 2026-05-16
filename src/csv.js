import fs from 'node:fs/promises';
import { resolveFromCwd } from './utils.js';
import { readShopeeToolRows } from './shopeeTool/source.js';

export async function readInputRows(args, options = {}) {
  const shopeeToolRows = await readShopeeToolRows(args, options);
  if (shopeeToolRows) return shopeeToolRows;

  const csvIndex = args.indexOf('--csv');
  const urlIndex = args.indexOf('--url');

  if (csvIndex >= 0) {
    const csvPath = args[csvIndex + 1];
    if (!csvPath) throw new Error('--csv requires a file path');
    const content = await fs.readFile(resolveFromCwd(csvPath), 'utf8');
    return parseCsv(content).map(normalizeRow);
  }

  if (urlIndex >= 0) {
    const url = args[urlIndex + 1];
    if (!url) throw new Error('--url requires an Amazon product URL');
    return [normalizeRow({ amazonUrl: url })];
  }

  throw new Error('Please pass --csv ./data/input.sample.csv or --url "https://..."');
}

function normalizeRow(row) {
  return {
    amazonUrl: row.amazonUrl || row.url || row.URL,
    stock: row.stock,
    priceOverride: row.priceOverride,
    targetLanguage: row.targetLanguage
  };
}

function parseCsv(content) {
  const rows = [];
  let current = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];
    if (char === '"' && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      row.push(current.trim());
      current = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(current.trim());
      current = '';
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
    } else {
      current += char;
    }
  }

  if (current || row.length) {
    row.push(current.trim());
    if (row.some((cell) => cell !== '')) rows.push(row);
  }

  const [headers, ...dataRows] = rows;
  if (!headers) return [];
  return dataRows.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] || ''])));
}
