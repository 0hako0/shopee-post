import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, resolveFromCwd, timestamp } from './utils.js';

export class Logger {
  constructor() {
    this.runId = timestamp();
    this.logDir = resolveFromCwd('./logs');
    this.screenshotDir = path.join(this.logDir, 'screenshots');
    this.logFile = path.join(this.logDir, `run-${this.runId}.log`);
  }

  async init() {
    await ensureDir(this.logDir);
    await ensureDir(this.screenshotDir);
  }

  async info(message, data = undefined) {
    await this.write('INFO', message, data);
  }

  async warn(message, data = undefined) {
    await this.write('WARN', message, data);
  }

  async error(message, data = undefined) {
    await this.write('ERROR', message, data);
  }

  async write(level, message, data) {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      data
    });
    console.log(`[${level}] ${message}`);
    await fs.appendFile(this.logFile, `${line}\n`, 'utf8');
  }

  async screenshot(page, label) {
    const file = path.join(this.screenshotDir, `${this.runId}-${label}.png`);
    await page.screenshot({ path: file, fullPage: true });
    await this.info('Saved screenshot', { file });
    return file;
  }
}
