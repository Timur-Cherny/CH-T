// Static checks of a storyboard before recording. Errors stop the recording; warnings are
// worth reading. Exit 1 on any error.
//   node lint-storyboard.mjs story.json
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stepsPerMinute, MAX_STEPS_PER_MIN } from './pace.mjs';

const path = resolve(process.argv[2] || '');
if (!existsSync(path)) { console.error('usage: node lint-storyboard.mjs <story.json>'); process.exit(64); }
const s = JSON.parse(readFileSync(path, 'utf8'));
const dir = dirname(path);
const errors = [], warns = [];
const words = (t = '') => t.replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
const inside = ([px, py], [x, y, w, h]) => px >= x && px <= x + w && py >= y && py <= y + h;
const SIDES = ['left', 'right', 'above', 'below'];

if (!['phone', 'web'].includes(s.device)) errors.push(`device must be "phone" or "web", got ${JSON.stringify(s.device)}`);
if (!Array.isArray(s.frame) || s.frame.length !== 2) errors.push('frame must be [width, height] of the screenshots in px');
const chapters = new Set((s.chapters || []).map((c) => c.id));
if (!chapters.size) errors.push('chapters: at least one chapter, one task the user does');
if (!s.summary || !(s.summary.items || []).length) warns.push('summary: no recap card — a daily user remembers 3–5 rules, not the walkthrough');

const perChapter = {};
(s.steps || []).forEach((st, i) => {
  const at = `step ${i + 1}${st.id ? ` (${st.id})` : ''}`;
  if (!chapters.has(st.chapter)) errors.push(`${at}: chapter "${st.chapter}" is not declared`);
  perChapter[st.chapter] = (perChapter[st.chapter] || 0) + 1;
  for (const f of [st.frame, st.result].filter(Boolean)) if (!existsSync(join(dir, f))) errors.push(`${at}: frame not found: ${f}`);
  if (st.claim && !st.evidence) errors.push(`${at}: claims system behaviour ("claim": true) without "evidence" — what run or code shows it`);
  if (st.card) {
    if (!st.card.title) errors.push(`${at}: card.title is required`);
    if (typeof st.claim !== 'boolean') errors.push(`${at}: a card explains without a screen — say whether it claims system behaviour: "claim": true with "evidence", or "claim": false`);
    return;
  }
  if (!st.caption || !st.caption.title) errors.push(`${at}: caption.title is required — one step, one thing to do`);
  else {
    if (words(st.caption.title) > 7) warns.push(`${at}: title has ${words(st.caption.title)} words — say the action in ≤6 words`);
    if (words(st.caption.body) > 26) warns.push(`${at}: body has ${words(st.caption.body)} words — split the step or move detail to the recap`);
  }
  if (st.kicker !== undefined && typeof st.kicker !== 'string') errors.push(`${at}: kicker is the short label above the title, a string`);
  if (st.pad !== undefined && !(Number.isFinite(st.pad) && st.pad >= 0 && st.pad <= 24)) errors.push(`${at}: pad is 0–24 canvas px between the target and the spotlight`);
  if (st.side !== undefined && !SIDES.includes(st.side)) errors.push(`${at}: side is one of ${SIDES.join(', ')}`);
  if (st.target) {
    const [x, y, w, h] = st.target;
    if (w <= 0 || h <= 0) errors.push(`${at}: target has no size`);
    if (s.frame && (x < 0 || y < 0 || x + w > s.frame[0] || y + h > s.frame[1])) errors.push(`${at}: target leaves the frame ${s.frame}`);
  } else if (st.action && st.action.type !== 'none') errors.push(`${at}: an action without a target — highlight what is pressed or scanned`);
  const a = st.action;
  if (a && ['tap', 'click', 'scan', 'type'].includes(a.type)) {
    if (!a.at) errors.push(`${at}: ${a.type} needs "at": [x, y]`);
    else if (st.target && !inside(a.at, st.target)) errors.push(['scan', 'type'].includes(a.type)
      ? `${at}: the ${a.type} badge is centred on "at" ${a.at} — put it inside the field it fills, or it covers the neighbours`
      : `${at}: the ${a.type} point ${a.at} is outside the highlighted target`);
  }
  if (a && ['scan', 'type'].includes(a.type) && !a.value) errors.push(`${at}: ${a.type} needs "value"`);
  if (st.hold && st.hold < 1) errors.push(`${at}: hold < 1 shortens reading below the rule; slow down instead of speeding up`);
});
for (const [ch, n] of Object.entries(perChapter)) if (n > 12) warns.push(`chapter "${ch}": ${n} steps — split it, a chapter is one task of 60–120 s`);

// Duration forecast: the player's own RULES and the same sequence as assets/player.html, before recording.
const player = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'player.html'), 'utf8');
const R = new Function(`return ${player.match(/const RULES = (\{[\s\S]*?\n\});/)[1]}`)();
const strip = (t = '') => t.replace(/<[^>]+>/g, '');
const reading = (...t) => Math.max(R.minCaptionMs, R.orientMs + (strip(t.filter(Boolean).join(' ')).length * 1000) / R.cps + R.bufferMs);
const listCard = (visible, items) => R.cardFadeMs + Math.max(R.listLeadMs, reading(visible) - R.bufferMs) + items.reduce((acc, i) => acc + Math.max(R.listItemMs, reading(i) - R.orientMs), 0);
const plainCard = (visible) => R.cardFadeMs + Math.max(R.cardMinMs, reading(visible)) + R.cardHideMs;
const [fw, fh] = s.frame || [1, 1];
const k = s.device === 'phone' ? 960 / fh : Math.min(1720 / fw, 900 / fh), devW = Math.round(fw * k);
const small = (t) => t && Math.min(t[2], t[3]) * k < R.zoomBelowPx && Math.max(t[2], t[3]) * k < devW * 0.4;

const chapterList = s.chapters || [];
const single = chapterList.length === 1;
let ms = (s.intro ? plainCard([s.intro.kicker || '', s.intro.title, s.intro.lead || ''].join(' ')) : 0);
let stepMs = 0;
const chapterMs = {};
let curFrame = null, prevChapter = null, zoomed = false;
for (const st of s.steps || []) {
  if (st.chapter !== prevChapter) {
    prevChapter = st.chapter;
    const ch = chapterList.find((c) => c.id === st.chapter) || { title: st.chapter };
    const n = chapterList.indexOf(ch) + 1;
    if (!(single && s.intro)) {
      const t = plainCard([single ? 'Задача' : `${n}Часть ${n} из ${chapterList.length}`, ch.title, ch.lead || ''].join(' '));
      chapterMs[st.chapter] = (chapterMs[st.chapter] || 0) + t; ms += t;
    }
  }
  let t = 0;
  if (st.card) {
    const c = st.card, visible = [c.kicker || '', c.title, ...(c.lead ? [c.lead] : [])].join(' ');
    t = c.items ? listCard(visible, c.items) + R.cardHideMs : plainCard(visible);
  } else {
    if (st.frame && st.frame !== curFrame) { t += R.frameMs + R.settleMs; curFrame = st.frame; }
    const on = st.zoom === true || (st.zoom !== false && small(st.target));
    if (on || zoomed) t += R.zoomMs;
    zoomed = on;
    if (st.target) t += R.spotMs;
    t += reading(st.caption?.title, st.caption?.body) * (st.hold || 1);
    const a = st.action?.type;
    if (a === 'tap' || a === 'click') t += R.fingerMs + 80 + R.tapMs;
    if (a === 'scan') t += R.scanMs + 250;
    if (a === 'type') t += R.typeCharMs * (st.action.value || '').length + 500 + 250;
    if (st.result && st.result !== curFrame) { t += R.frameMs + R.settleMs; curFrame = st.result; }
    t += R.resultMs;
  }
  stepMs += t;
  chapterMs[st.chapter] = (chapterMs[st.chapter] || 0) + t; ms += t;
}
const summaryVisible = [s.summary?.kicker || 'Памятка', s.summary?.title].join(' ');
ms += (s.summary ? listCard(summaryVisible, s.summary.items || []) : 0) + R.summaryHoldMs;
const pace = s.pace || 1;
ms = ms * pace + R.recStartMs; stepMs *= pace;
const steps = (s.steps || []).length;
const perMin = stepsPerMinute(steps, stepMs);
for (const [ch, t] of Object.entries(chapterMs)) if (t * pace > 150000) warns.push(`chapter "${ch}": ~${Math.round((t * pace) / 1000)} s — longer than a task needs; cut steps, not reading time`);
if (perMin > MAX_STEPS_PER_MIN) warns.push(`~${perMin.toFixed(1)} steps/min — faster than ${MAX_STEPS_PER_MIN} feels rushed; cut steps or merge an explanation into the next caption`);
console.log(`forecast: ~${Math.round(ms / 1000)} s total, ~${perMin.toFixed(1)} steps/min of step time (pace ${pace})`);

for (const w of warns) console.log(`warn  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
console.log(`${steps} steps, ${chapters.size} chapters: ${errors.length} errors, ${warns.length} warnings`);
process.exit(errors.length ? 1 : 0);
