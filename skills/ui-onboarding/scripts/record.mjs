// Records a storyboard through assets/player.html into <out>.webm, writes the player's
// timeline to <out>.timeline.json and converts to <out>.mp4 (scripts/to-mp4.sh).
//
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node record.mjs story.json out/name [--pace 1] [--no-mp4]
//
// The timeline is what the viewer actually got: where each callout stood relative to its
// target and how long it was readable. lint-timeline.mjs checks it; the storyboard alone
// cannot prove placement.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { headlessShell } from './browser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [storyArg, outArg, ...rest] = process.argv.slice(2);
if (!storyArg || !outArg) { console.error('usage: node record.mjs <story.json> <out-path-without-ext> [--pace N] [--no-mp4]'); process.exit(64); }
const pace = rest.includes('--pace') ? Number(rest[rest.indexOf('--pace') + 1]) : null;
const storyPath = resolve(storyArg); const out = resolve(outArg);
mkdirSync(dirname(out), { recursive: true });

const launch = headlessShell();

const story = JSON.parse(readFileSync(storyPath, 'utf8'));
const base = `file://${dirname(storyPath)}/`;
const tmp = `${out}.rec-tmp`; mkdirSync(tmp, { recursive: true });

const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, recordVideo: { dir: tmp, size: { width: 1920, height: 1080 } } });
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.error('player:', m.text()); });
await page.addInitScript(({ s, b }) => { window.__STORY = s; window.__BASE = b; }, { s: story, b: base });
const player = `file://${join(here, '..', 'assets', 'player.html')}?rec=1${pace ? `&pace=${pace}` : ''}`;
const t0 = Date.now();
await page.goto(player);
await page.waitForFunction(() => window.__done === true, null, { timeout: 45 * 60 * 1000, polling: 500 });
const timeline = await page.evaluate(() => window.__timeline || []);
const marks = await page.evaluate(() => window.__marks || []);
const error = await page.evaluate(() => window.__error || null);
const video = page.video();
await context.close(); await browser.close();
renameSync(await video.path(), `${out}.webm`);
rmSync(tmp, { recursive: true, force: true });
writeFileSync(`${out}.timeline.json`, JSON.stringify({ story: storyPath, device: story.device, pace: pace || story.pace || 1, seconds: Math.round((Date.now() - t0) / 1000), steps: timeline, cards: marks }, null, 1));
console.log(`webm ${out}.webm  timeline ${out}.timeline.json  steps=${timeline.length}  ${Math.round((Date.now() - t0) / 1000)}s`);
if (error) { console.error(`player error: ${error}`); process.exit(1); }
if (!rest.includes('--no-mp4')) execFileSync('bash', [join(here, 'to-mp4.sh'), `${out}.webm`, `${out}.mp4`], { stdio: 'inherit' });
