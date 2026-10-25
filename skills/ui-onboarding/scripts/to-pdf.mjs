// Renders a storyboard as a PDF deck to read without a player: one 1920×1080 page per slide of
// assets/player.html in still mode — intro, chapter cards, every step as the viewer reads it
// (before the action), card steps and the recap with every item shown.
//
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node to-pdf.mjs story.json out.pdf [--slides dir]
//
// --slides keeps the slide PNGs in <dir> to look at; otherwise they go to a temp dir that is removed.
// A slide whose callout covers its target or whose text leaves the canvas fails the run: no PDF.
// The PDF must have exactly one page per slide, or the run fails and the PDF is removed.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { headlessShell } from './browser.mjs';

const W = 1920, H = 1080;
const MAX_BYTES = 40 * 1024 * 1024; // a PDF above this is rebuilt with JPEG slides
const JPEG_QUALITY = 88;

const here = dirname(fileURLToPath(import.meta.url));
const [storyArg, outArg, ...rest] = process.argv.slice(2);
if (!storyArg || !outArg) { console.error('usage: node to-pdf.mjs <story.json> <out.pdf> [--slides <dir>]'); process.exit(64); }
const keep = rest.includes('--slides') ? resolve(rest[rest.indexOf('--slides') + 1]) : null;
const storyPath = resolve(storyArg); const out = resolve(outArg);
const launch = headlessShell();
const story = JSON.parse(readFileSync(storyPath, 'utf8'));
mkdirSync(dirname(out), { recursive: true });
const dir = keep || mkdtempSync(join(tmpdir(), 'onb-pdf-'));
mkdirSync(dir, { recursive: true });
const esc = (t = '') => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

const browser = await launch();
try {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error('player:', m.text()); });
  page.on('pageerror', (e) => console.error('player:', e.message));
  await page.addInitScript(({ s, b }) => { window.__STORY = s; window.__BASE = b; window.__STILL = true; }, { s: story, b: `${pathToFileURL(dirname(storyPath)).href}/` });
  await page.goto(`${pathToFileURL(join(here, '..', 'assets', 'player.html')).href}?still=1`);
  await page.waitForFunction(() => window.__slides, null, { timeout: 120000, polling: 200 });
  const slides = await page.evaluate(() => window.__slides);
  const names = slides.map((s, i) => `${String(i + 1).padStart(3, '0')}-${s.kind}`);

  const fails = [];
  const shoot = async (type) => {
    for (let i = 0; i < slides.length; i++) {
      const { problems } = await page.evaluate((n) => window.__show(n), i);
      for (const p of problems) fails.push(`slide ${i + 1} (${slides[i].kind} «${slides[i].label}»): ${p}`);
      await page.screenshot({ path: join(dir, `${names[i]}.${type === 'png' ? 'png' : 'jpg'}`), type, ...(type === 'jpeg' ? { quality: JPEG_QUALITY } : {}), clip: { x: 0, y: 0, width: W, height: H } });
    }
  };
  const compose = async (ext) => {
    const html = join(dir, 'deck.html');
    writeFileSync(html, `<!doctype html><meta charset="utf-8"><title>${esc(story.title)}</title>
<style>@page { size: ${W}px ${H}px; margin: 0 } html, body { margin: 0 } img { display: block; width: ${W}px; height: ${H}px; break-after: page } img:last-child { break-after: auto }</style>
${names.map((n) => `<img src="${n}.${ext}">`).join('\n')}`);
    const p = await context.newPage();
    await p.goto(pathToFileURL(html).href, { waitUntil: 'load' });
    await p.pdf({ path: out, width: `${W}px`, height: `${H}px`, printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    await p.close(); rmSync(html);
    return statSync(out).size;
  };

  await shoot('png');
  if (fails.length) {
    for (const f of fails) console.error(`FAIL ${f}`);
    console.error(`${fails.length} slide problems: no PDF${keep ? `; slides in ${dir}` : ''}`);
    process.exitCode = 1;
  } else {
    let size = await compose('png'), jpeg = false;
    if (size > MAX_BYTES) { fails.length = 0; await shoot('jpeg'); size = await compose('jpg'); jpeg = true; }
    const pages = (readFileSync(out, 'latin1').match(/\/Type\s*\/Page\b/g) || []).length;
    if (pages !== slides.length) {
      rmSync(out, { force: true });
      console.error(`FAIL the PDF has ${pages} pages for ${slides.length} slides: removed`);
      process.exitCode = 1;
    } else console.log(`${slides.length} slides → ${out} (${mb(size)}${jpeg ? `, JPEG q${JPEG_QUALITY}` : ''})`);
  }
} finally {
  await browser.close();
  if (!keep && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
