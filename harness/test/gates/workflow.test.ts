// TS-AST port of hooks/workflow-friction-gate.sh. A workflow script may set opts.model: the ban on an
// explicit model holds for Agent|Task only, where nothing but inheritance bounds the subagent.
// Молча ломалось: grep по JS — комментарий `// friction`, переменная "frictionless" и динамический prompt
// проходили или отвергались текстом, а не структурой (К1, deny-gates.test.sh:69-71).
// INVARIANT: каждый статический вызов agent() требует «Трение»/friction в доказуемо-статичном prompt либо schema.properties.friction;
// opts.model is not judged. REGRESSION: a comment or a look-alike word does not fulfil the contract.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, payload, HARNESS_ROOT } from '../_env.ts';
import { TS_PATH } from '../checks/_repo.ts';
import { decideFriction, NAME } from '../../src/gates/workflow.ts';
import { GATES } from '../../src/gates/registry.ts';
import { route } from '../../src/main.ts';
import type { GateContext, HookPayload, Verdict } from '../../src/types.ts';

const sb = sandbox();
after(() => sb.cleanup());

function wf(script: string, extra: Record<string, unknown> = {}): HookPayload {
  return payload('PreToolUse', { tool_name: 'Workflow', tool_input: { script, ...extra }, tool_use_id: 'toolu_wf' }, sb.dir) as unknown as HookPayload;
}
function ctx(p: HookPayload, env: Record<string, string> = { CLAUDE_HARNESS_TS: TS_PATH }): GateContext {
  return { event: 'pre-agent', payload: p, env, root: HARNESS_ROOT, stateDir: sb.stateDir, now: Date.now };
}
const friction = (script: string, env?: Record<string, string>): Verdict => decideFriction(ctx(wf(script), env));
const reason = (v: Verdict): string => ('reason' in v ? v.reason : '');

describe('workflow-friction-gate (bash corpus)', () => {
  it('registers the friction gate on pre-agent and no gate that judges a workflow model', () => {
    const f = GATES.find((g) => g.name === NAME);
    assert.equal(f?.killSwitch, 'CLAUDE_SKIP_FRICTION_GATE');
    assert.deepEqual(f?.events, ['pre-agent']);
    assert.equal(GATES.some((g) => g.name === 'workflow-model-gate'), false);
  });
  it('denies agent() whose prompt never asks for «Трение»', () => {
    const v = friction('const r=await agent("найди баги")');
    assert.equal(v.kind, 'deny'); assert.match(reason(v), /L1\b/); assert.match(reason(v), /Трение/);
  });
  it('allows a prompt that requires «Трение»', () => { assert.equal(friction('const r=await agent("найди баги. Заверши секцией ## Трение")').kind, 'silent'); });
  it('allows a schema with a friction field passed through a variable', () => {
    assert.equal(friction('const S={type:"object",properties:{friction:{type:"string"}}}\nawait agent("x",{schema:S})').kind, 'silent');
  });
  it('stays silent on a script without agent()', () => { assert.equal(friction('log("hi")').kind, 'silent'); });
  it('denies when only a comment mentions friction — a comment is not a contract (К1)', () => {
    assert.equal(friction('// friction: ничего\nconst r=await agent("найди баги")').kind, 'deny');
  });
  it('denies when the word appears as a variable "frictionless" elsewhere (К1)', () => {
    assert.equal(friction('const n="frictionless"\nawait agent("найди баги")').kind, 'deny');
  });
  it('denies a dynamic prompt that cannot be proven — buildPrompt() is not evidence', () => {
    const v = friction('const p=buildPrompt(); await agent(p)');
    assert.equal(v.kind, 'deny'); assert.match(reason(v), /динамич/);
  });
  it('denies when one of two agent() calls lacks the section and names that line', () => {
    const v = friction('await agent("## Трение обязательно");\nawait agent("просто отчёт")');
    assert.equal(v.kind, 'deny'); assert.match(reason(v), /L2\b/); assert.doesNotMatch(reason(v), /L1\b/);
  });
  it('allows two calls when both prompts require the section, in either language', () => {
    assert.equal(friction('await agent("## Трение обязательно"); await agent("Add ## Friction")').kind, 'silent');
  });
});

describe('workflow-friction-gate (structural cases beyond the bash corpus)', () => {
  it('resolves a const string identifier to its literal — the contract is proven, not guessed', () => {
    assert.equal(friction('const p = "Отчёт заверши секцией ## Трение"; await agent(p)').kind, 'silent');
  });
  it('accepts the word inside the static part of a template literal and a literal concatenation', () => {
    assert.equal(friction('const task = load(); await agent(`Сделай ${task}. Заверши ## Трение`)').kind, 'silent');
    assert.equal(friction('await agent("найди баги. " + "## Трение обязательно")').kind, 'silent');
  });
  it('denies a template whose only friction word sits inside an interpolation', () => {
    assert.equal(friction('const w = "Трение"; await agent(`найди баги ${w()}`)').kind, 'deny');
  });
  it('denies a literal schema without a friction property and a schema imported from elsewhere', () => {
    assert.equal(friction('await agent("x", {schema: {type:"object", properties: {name: {type:"string"}}}})').kind, 'deny');
    const v = friction('import { S } from "./schema.ts"; await agent("x", {schema: S})');
    assert.equal(v.kind, 'deny'); assert.match(reason(v), /schema/);
  });
  it('denies "frictionless" and «Трением» in the prompt itself — whole-word match in both alphabets', () => {
    assert.equal(friction('await agent("be frictionless about it")').kind, 'deny');
    assert.equal(friction('await agent("с Трением не считается")').kind, 'deny');
  });
  it('counts a property call ctx.agent(...) as an agent call', () => {
    assert.equal(friction('await ctx.agent("найди баги")').kind, 'deny');
    assert.equal(friction('await ctx.agent("найди баги; ## Трение")').kind, 'silent');
  });
  it('reads the script from scriptPath when script is absent, and answers unknown when the path is unreadable', () => {
    const p = join(sb.dir, 'wf.ts'); writeFileSync(p, 'await agent("найди баги")\n');
    const denied = decideFriction(ctx(wf('', { script: undefined, scriptPath: p })));
    assert.equal(denied.kind, 'deny');
    const missing = decideFriction(ctx(wf('', { script: undefined, scriptPath: join(sb.dir, 'absent.ts') })));
    assert.equal(missing.kind, 'unknown'); assert.match(reason(missing), /scriptPath/);
  });
  it('answers unknown when no typescript is reachable and when the script does not parse', () => {
    const noTs = friction('await agent("найди баги")', {});
    assert.equal(noTs.kind, 'unknown'); assert.match(reason(noTs), /typescript/i);
    const broken = friction('await agent("найди баги"');
    assert.equal(broken.kind, 'unknown'); assert.match(reason(broken), /разобран/);
  });
  it('stays silent for a non-Workflow tool and for an empty script', () => {
    const agentTool = payload('PreToolUse', { tool_name: 'Agent', tool_input: { prompt: 'x' } }) as unknown as HookPayload;
    assert.equal(decideFriction(ctx(agentTool)).kind, 'silent');
    assert.equal(friction('').kind, 'silent');
  });
});

describe('opts.model in a workflow script', () => {
  const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, CLAUDE_HARNESS_TS: TS_PATH };
  it('passes route() for any model once the friction contract holds — literal, variable, shorthand and spread', async () => {
    for (const script of [
      'await agent("## Трение",{model:"claude-opus-5"})',
      'await agent("## Трение",{model:"claude-fable-5"})',
      'const o={model:"claude-opus-5"}; await agent("## Трение", o)',
      'const model="claude-opus-5"; await agent("## Трение", {model})',
      'const base={model:"x"}; await agent("## Трение", {...base, maxTurns: 2})',
    ]) assert.equal((await route('pre-agent', wf(script), env)).kind, 'silent', script);
  });
  it('still denies an explicit model on the Agent tool — the ban moved off workflows, not off subagents', async () => {
    const agentTool = payload('PreToolUse', { tool_name: 'Agent', tool_input: { prompt: 'x', model: 'opus' } }, sb.dir) as unknown as HookPayload;
    const v = await route('pre-agent', agentTool, env);
    assert.equal(v.kind, 'deny'); assert.equal((v as { gate: string }).gate, 'model-gate');
  });
  it('does not excuse the friction contract: a model in opts and a prompt without «Трение» is denied for the prompt', async () => {
    const v = await route('pre-agent', wf('await agent("найди баги",{model:"claude-opus-5"})'), env);
    assert.equal(v.kind, 'deny'); assert.equal((v as { gate: string }).gate, NAME); assert.doesNotMatch(reason(v), /наследовать/);
  });
});

describe('kill-switches through route()', () => {
  const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, CLAUDE_HARNESS_TS: TS_PATH };
  it('CLAUDE_SKIP_FRICTION_GATE=1 alone silences a workflow script and writes no files under the state dir', async () => {
    const v = await route('pre-agent', wf('await agent("найди баги",{model:"claude-fable-5"})'), { ...env, CLAUDE_SKIP_FRICTION_GATE: '1' });
    assert.equal(v.kind, 'silent');
    assert.deepEqual(readdirSync(sb.stateDir), []);
  });
  it('without the switch route() denies for the friction contract only', async () => {
    const v = await route('pre-agent', wf('await agent("найди баги",{model:"claude-fable-5"})'), env);
    assert.equal(v.kind, 'deny'); assert.match(reason(v), /Трение/); assert.doesNotMatch(reason(v), /наследовать/);
  });
});
