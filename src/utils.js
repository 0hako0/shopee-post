import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export function resolveFromCwd(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

export async function ensureDir(dirPath) {
  await fs.mkdir(resolveFromCwd(dirPath), { recursive: true });
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export async function prompt(message) {
  const rl = readline.createInterface({ input, output });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).replace(/[^\d.]/g, '');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}
