// Checks what the viewer actually saw, from the timeline record.mjs saved:
// - the callout never covers its target;
// - it stands next to the target (phone: against the device edge, at the target's height;
//   web: within a short gap of the target);
// - it stayed readable for at least the reading time of its text.
// Exit 1 on any violation.
//   node lint-timeline.mjs out/name.timeline.json
import { readFileSync } from 'node:fs';
import { stepsPerMinute, MAX_STEPS_PER_MIN } from './pace.mjs';

const LIMITS = { phoneEdgeGap: 60, phoneVerticalOffset: 220, webGap: 80, slackMs: 60 };
const t = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const bad = [];
let reading = 0, total = 0;
for (const s of t.steps) {
  const at = `step ${s.i + 1} (${s.id})`;
  total += s.ms;
  if (s.card) continue;
  reading += s.shownMs;
  if (s.overlap) bad.push(`${at}: the callout covers the target`);
  if (s.target) {
    if (s.device === 'phone') {
      if (s.deviceEdgeGap > LIMITS.phoneEdgeGap) bad.push(`${at}: callout ${s.deviceEdgeGap}px from the device (≤${LIMITS.phoneEdgeGap})`);
      if (s.verticalOffset > LIMITS.phoneVerticalOffset) bad.push(`${at}: callout ${s.verticalOffset}px above/below the target (≤${LIMITS.phoneVerticalOffset}) — eyes travel`);
    } else if (s.gap > LIMITS.webGap) bad.push(`${at}: callout ${s.gap}px from the target (≤${LIMITS.webGap})`);
  }
  if (s.shownMs + LIMITS.slackMs < s.requiredMs) bad.push(`${at}: readable ${s.shownMs}ms, needs ${s.requiredMs}ms`);
}
const min = (total / 60000).toFixed(1), perMin = stepsPerMinute(t.steps.length, total);
console.log(`${t.steps.length} steps, ${min} min of steps, ${Math.round((reading / Math.max(total, 1)) * 100)}% of the time a callout is readable, ${perMin.toFixed(1)} steps/min of step time`);
if (perMin > MAX_STEPS_PER_MIN) console.log(`warn  ${perMin.toFixed(1)} steps/min — faster than ${MAX_STEPS_PER_MIN} feels rushed; cut steps, not reading time`);
for (const b of bad) console.log(`FAIL ${b}`);
process.exit(bad.length ? 1 : 0);
