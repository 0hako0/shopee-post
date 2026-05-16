import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveFromCwd } from './utils.js';

const DEFAULT_PATH = './data/processed-products.json';

export async function loadProcessedProducts(args) {
  const filePath = getArg(args, '--processed-file') || DEFAULT_PATH;
  const resolvedPath = resolveFromCwd(filePath);
  const data = await readJson(resolvedPath);

  return {
    filePath: resolvedPath,
    data,
    includeProcessed: args.includes('--include-processed'),
    skipProcessed: args.includes('--skip-processed')
  };
}

export function shouldUseProcessedFilter(rows, processed) {
  if (processed.includeProcessed) return false;
  if (processed.skipProcessed) return true;
  return rows.some((row) => row.productFromTool?.shopeeTool?.id);
}

export function splitProcessedRows(rows, processed) {
  const active = [];
  const skipped = [];

  for (const row of rows) {
    if (isProcessed(row, processed.data)) {
      skipped.push(row);
    } else {
      active.push(row);
    }
  }

  return { active, skipped };
}

export function isProcessed(row, data) {
  const key = processedKey(row);
  if (!key) return false;
  return (data[key.market] || []).some((item) => String(item.id) === key.id);
}

export function applyProcessedStatus(rows, processed) {
  return rows.map((row) => ({
    ...row,
    isAlreadyProcessed: isProcessed(row, processed.data)
  }));
}

export async function markProcessed(row, processed, meta = {}) {
  const key = processedKey(row);
  if (!key) return false;

  const existing = processed.data[key.market] || [];
  if (existing.some((item) => String(item.id) === key.id)) return true;

  processed.data[key.market] = [
    ...existing,
    {
      id: key.id,
      title: key.title,
      sourceUrl: key.sourceUrl,
      markedAt: new Date().toISOString(),
      ...meta
    }
  ];

  await fs.mkdir(path.dirname(processed.filePath), { recursive: true });
  await fs.writeFile(processed.filePath, `${JSON.stringify(processed.data, null, 2)}\n`, 'utf8');
  return true;
}

export function processedKey(row) {
  const tool = row.productFromTool?.shopeeTool;
  if (!tool?.id) return null;

  return {
    id: String(tool.id),
    market: String(tool.market || 'default').toLowerCase(),
    title: row.productFromTool?.title || tool.name || '',
    sourceUrl: row.amazonUrl || row.productFromTool?.url || ''
  };
}

async function readJson(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function getArg(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}
