// One way to a browser for record.mjs and to-pdf.mjs: playwright-core from PLAYWRIGHT_CORE (or the
// cwd's node_modules) and the headless shell from the Playwright cache. Resolves now, launches later.
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function headlessShell() {
  const req = createRequire(join(process.cwd(), 'noop.js'));
  const pwPath = process.env.PLAYWRIGHT_CORE || (() => { try { return dirname(req.resolve('playwright-core/package.json')); } catch { return null; } })();
  if (!pwPath) { console.error('playwright-core not found: set PLAYWRIGHT_CORE=<dir of playwright-core> (npm i playwright-core in any temp dir)'); process.exit(69); }
  const { chromium } = req(pwPath);
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const shell = existsSync(cache) && readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().pop();
  const executablePath = shell ? (() => {
    const root = join(cache, shell); const sub = readdirSync(root).find((d) => d.startsWith('chrome-')); return join(root, sub, 'chrome-headless-shell');
  })() : undefined;
  return () => chromium.launch({ headless: true, executablePath });
}
