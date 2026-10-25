// INVARIANT: an unhandled @agent comment is named at session start; a silent tracker is reported, not mistaken for an empty queue.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sandbox, payload, HARNESS_ROOT } from '../_env.ts';
import { decide, NAME, TOKEN_FILE } from '../../src/session/tracker-inbox.ts';
import type { GateContext } from '../../src/types.ts';

const sb = sandbox('harness-trkinbox-');
after(() => sb.cleanup());

const bare = join(sb.dir, 'bare-home');
mkdirSync(bare, { recursive: true });
const withTracker = join(sb.dir, 'tracker-home');
mkdirSync(dirname(join(withTracker, TOKEN_FILE)), { recursive: true });
writeFileSync(join(withTracker, TOKEN_FILE), 'x');

const ctxFor = (env: NodeJS.ProcessEnv): GateContext => ({
  event: 'session-start', payload: payload('SessionStart', { source: 'startup' }, sb.dir) as never,
  env, root: HARNESS_ROOT, stateDir: sb.stateDir, now: () => 0,
});
const answer = (body: unknown, status = 200) => async () => ({ ok: status < 400, status, json: async () => body });
const text = (v: { kind: string }) => (v as { text: string }).text;
const never = async () => { throw new Error('the gate must not call the tracker here'); };

describe(NAME, () => {
  it('names every issue that has an unhandled @agent comment, once per issue', async () => {
    const v = await decide(ctxFor({ HOME: withTracker }), answer([
      { issue: 'APP-32', acked: null }, { issue: 'APP-36', acked: null }, { issue: 'APP-32', acked: null },
    ]));
    assert.equal(v.kind, 'context');
    assert.match(text(v), /^\[трекер\] @agent ждут ответа: 3 — APP-32, APP-36\. .*tracker_inbox.*tracker_start.*tracker_ack/);
  });

  it('stays silent on an empty queue and ignores rows already acked', async () => {
    assert.equal((await decide(ctxFor({ HOME: withTracker }), answer([]))).kind, 'silent');
    assert.equal((await decide(ctxFor({ HOME: withTracker }), answer([{ issue: 'APP-1', acked: 1790000000000 }]))).kind, 'silent');
  });

  it('reports a tracker that is down or answers with an error instead of calling the queue empty', async () => {
    const down = async () => { throw new TypeError('fetch failed'); };
    assert.match(text(await decide(ctxFor({ HOME: withTracker }), down)), /очередь @agent не проверена: http:\/\/tracker\.localhost не отвечает/);
    assert.match(text(await decide(ctxFor({ HOME: withTracker }), answer({ error: 'x' }, 503))), /ответил 503/);
    assert.match(text(await decide(ctxFor({ HOME: withTracker }), answer({ not: 'a list' }))), /ответ не список/);
  });

  it('says so when the tracker does not answer within the timeout', async () => {
    const slow = async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); };
    assert.match(text(await decide(ctxFor({ HOME: withTracker }), slow)), /нет ответа за \d+ мс/);
  });

  it('does not touch the network on a machine without the tracker installed', async () => {
    assert.equal((await decide(ctxFor({ HOME: bare }), never)).kind, 'silent');
    assert.equal((await decide(ctxFor({}), never)).kind, 'silent');
  });

  it('an explicit TRACKER_URL is queried even without the token file, trailing slash dropped', async () => {
    let asked = '';
    const spy = async (url: string) => { asked = url; return { ok: true, status: 200, json: async () => [] }; };
    await decide(ctxFor({ HOME: bare, TRACKER_URL: 'http://127.0.0.1:8099/' }), spy);
    assert.equal(asked, 'http://127.0.0.1:8099/api/agent/inbox');
  });

  it('shows at most eight issue ids and counts the rest', async () => {
    const rows = Array.from({ length: 11 }, (_, k) => ({ issue: `APP-${k + 1}`, acked: null }));
    assert.match(text(await decide(ctxFor({ HOME: withTracker }), answer(rows))), /APP-8 и ещё 3\./);
  });
});
