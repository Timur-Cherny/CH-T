// Порт hooks/spec/skill-telemetry-contract.test.sh (INC-FRICTION-SKILL-FIELD-DRIFT): скилл не может опираться на поле,
// которого эмиттер не пишет — friction-review читал signature/repeat/trace, которых claude-friction-2 не пишет вовсе.
// REGRESSION 3ccbac8: bash-оригинал без каталога скиллов или без контрактов выходил с кодом 0 ДО половины на фикстуре —
// прогон из нуля сверок считался зелёным.
// INVARIANT: фикстура выполняется всегда и сверяет больше нуля контрактов; живая половина берёт строки у текущих
// адаптеров в песочнице (I7), а «не к чему применить» видно как skipped с причиной, а не как pass.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { route } from '../../src/main.ts';
import { checkContracts, type Report, type Row, type RowsByJournal } from '../../scripts/telemetry-contract.ts';
import { HARNESS_ROOT, sandbox, payload, onlyGate, assertNotReal, type Sandbox } from '../_env.ts';

const SKILLS_DIR = process.env.TELEMETRY_CONTRACT_SKILLS_DIR || join(HARNESS_ROOT, '..', 'skills');

function skillsDir(sb: Sandbox, name: string, skills: Record<string, string>): string {
  const dir = join(sb.dir, name);
  mkdirSync(dir, { recursive: true });
  for (const [skill, body] of Object.entries(skills)) { mkdirSync(join(dir, skill), { recursive: true }); writeFileSync(join(dir, skill, 'SKILL.md'), body); }
  return dir;
}
const row = (adapter: string, extra: Record<string, unknown> = {}): Row => ({ ts: '2026-09-10T00:00:00Z', adapter, executor: 'x', ...extra });

describe('checkContracts', () => {
  const sb = sandbox('harness-tcontract-');
  after(() => sb.cleanup());

  it('names the declared field that no row of the newest adapter carries — the bash fixture, Cyrillic field name included', () => {
    const dir = skillsDir(sb, 'drift', { probe: 'x\n<!-- telemetry-contract: probe.jsonl = ts,НЕТ_ТАКОГО_ПОЛЯ -->\n' });
    const r = checkContracts(dir, { 'probe.jsonl': [row('probe-1')] });
    assert.deepEqual(r.problems, ['probe → probe.jsonl (probe-1) не пишет: НЕТ_ТАКОГО_ПОЛЯ']);
    assert.equal(r.checked, 1, 'the fixture compared nothing — a problem-free result here would be vacuous');
  });
  it('reports no problem when every declared field is written — the paired side of the same fixture, with a non-zero check count', () => {
    const dir = skillsDir(sb, 'match', { probe: 'x\n<!-- telemetry-contract: probe.jsonl = ts,executor -->\n' });
    const r = checkContracts(dir, { 'probe.jsonl': [row('probe-1')] });
    assert.deepEqual(r.problems, []);
    assert.equal(r.checked, 1, 'zero comparisons would make the empty problem list meaningless');
    assert.deepEqual(r.notApplicable, []);
  });
  it('judges only rows of the newest adapter — a field an older adapter version wrote does not keep the contract alive', () => {
    const dir = skillsDir(sb, 'versions', { 'friction-review': '<!-- telemetry-contract: probe.jsonl = ts,signature -->\n' });
    const r = checkContracts(dir, { 'probe.jsonl': [row('probe-1', { signature: 's' }), row('probe-2')] });
    assert.deepEqual(r.problems, ['friction-review → probe.jsonl (probe-2) не пишет: signature']);
  });
  it('takes the union of keys over newest-adapter rows — a field written on one row kind only still counts as written', () => {
    const dir = skillsDir(sb, 'union', { probe: '<!-- telemetry-contract: probe.jsonl = ts,scope,missing_reason -->\n' });
    const r = checkContracts(dir, { 'probe.jsonl': [row('p', { missing_reason: 'not_a_git_repo' }), row('p', { scope: 'function' })] });
    assert.deepEqual([r.problems, r.checked], [[], 1]);
  });
  it('counts one check per declaration — two contracts in one SKILL.md and a skill in a nested directory are all compared', () => {
    const dir = skillsDir(sb, 'many', {
      a: '<!-- telemetry-contract: one.jsonl = ts -->\ntext\n<!-- telemetry-contract: two.jsonl = executor -->\n',
      'group/b': '<!-- telemetry-contract: one.jsonl = adapter -->\n',
    });
    const r = checkContracts(dir, { 'one.jsonl': [row('p')], 'two.jsonl': [row('p')] });
    assert.deepEqual([r.problems, r.checked], [[], 3]);
  });
  it('treats a journal without rows as not applicable, never as a pass — neither counted as checked nor reported as a problem', () => {
    const dir = skillsDir(sb, 'no-rows', { probe: '<!-- telemetry-contract: absent.jsonl = ts -->\n' });
    const r = checkContracts(dir, { 'absent.jsonl': [] });
    assert.deepEqual([r.problems, r.checked], [[], 0]);
    assert.deepEqual(r.notApplicable, ['probe → absent.jsonl: в absent.jsonl нет ни одной строки — сверять не с чем']);
  });
  for (const [label, decl] of [
    ['a hyphen in a field name', '<!-- telemetry-contract: probe.jsonl = ts,agent-id -->'],
    ['a declaration without fields', '<!-- telemetry-contract: probe.jsonl = , -->'],
    ['a declaration without an equals sign', '<!-- telemetry-contract: probe.jsonl ts,executor -->'],
  ] as const) {
    it(`reports ${label} as a problem instead of dropping the declaration silently`, () => {
      const dir = skillsDir(sb, `malformed-${label.replaceAll(' ', '-')}`, { probe: `${decl}\n` });
      const r = checkContracts(dir, { 'probe.jsonl': [row('probe-1')] });
      assert.equal(r.problems.length, 1, JSON.stringify(r));
      assert.match(r.problems[0], /^probe: /);
      assert.equal(r.checked, 0);
    });
  }
  it('answers not applicable for a missing and for an empty skills directory — zero contracts is not a green check', () => {
    const missing = checkContracts(join(sb.dir, 'absent-skills'), {});
    assert.deepEqual([missing.problems, missing.checked], [[], 0]);
    assert.match(missing.notApplicable.join(), /нет каталога скиллов/);
    const empty = checkContracts(skillsDir(sb, 'empty-skills', {}), {});
    assert.deepEqual([empty.problems, empty.checked], [[], 0]);
    assert.match(empty.notApplicable.join(), /ни один скилл .* не объявил контракт/);
  });
});

const CODEX_LINE = '{"payload":{"info":{"total_token_usage":{"total_tokens":8,"input_tokens":6,"cached_input_tokens":2,"output_tokens":2,"reasoning_output_tokens":0}}}}\n';
const MSG_LINE = '{"message":{"usage":{"input_tokens":3,"cache_creation_input_tokens":1,"cache_read_input_tokens":2,"output_tokens":4}}}\n';

function readJsonl(p: string): Row[] {
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row) : [];
}

/** Строки пишут текущие адаптеры через роутер, в песочнице: оба вида строк трения и оба контура расхода. */
async function currentAdapterRows(sb: Sandbox): Promise<RowsByJournal> {
  const base = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT };
  const outside = join(sb.dir, 'no-git'); mkdirSync(outside, { recursive: true });
  await route('agent-stop', payload('SubagentStop', { session_id: 'contract-outside', agent_id: 'a-outside', agent_type: 'worker' }, outside) as never, { ...base, ...onlyGate('friction') });
  const repo = join(sb.dir, 'repo'); mkdirSync(repo, { recursive: true });
  for (const args of [['init', '-q'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init', '--allow-empty']]) {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: sb.home, GIT_CONFIG_NOSYSTEM: '1' } });
    if (r.status !== 0) throw new Error(r.stderr);
  }
  mkdirSync(join(repo, 'src')); writeFileSync(join(repo, 'src', 'a.py'), 'x = 1\n');
  await route('agent-stop', payload('SubagentStop', { session_id: 'contract-diff', agent_id: 'a-diff', agent_type: 'worker' }, repo) as never, { ...base, ...onlyGate('friction') });

  const transcripts: Array<[string, string]> = [
    [join(sb.home, '.codex', 'sessions', '2026', 'session.jsonl'), CODEX_LINE],
    [join(sb.home, '.claude', 'projects', 'project', 'subagents', 'agent.jsonl'), MSG_LINE],
    [join(sb.home, '.claude-corp', 'projects', 'project', 'session.jsonl'), MSG_LINE],
  ];
  for (const [p] of transcripts) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, ''); }
  await route('stop', payload('Stop') as never, { ...base, ...onlyGate('telemetry') }); // посев: офсеты без записи
  for (const [p, line] of transcripts) appendFileSync(p, line);
  await route('stop', payload('Stop') as never, { ...base, ...onlyGate('telemetry') });

  return {
    'personal-friction.jsonl': readJsonl(join(sb.home, '.claude', 'exec-telemetry', 'personal-friction.jsonl')),
    'personal.jsonl': readJsonl(join(sb.stateDir, 'personal.jsonl')),
    'corp.jsonl': readJsonl(join(sb.stateDir, 'corp.jsonl')),
  };
}

describe('checkContracts — live: repository skills against rows the current adapters write', async () => {
  const sb = sandbox('harness-tcontract-live-');
  after(() => sb.cleanup());
  assertNotReal(SKILLS_DIR);
  const report: Report = checkContracts(SKILLS_DIR, await currentAdapterRows(sb));

  it('names no problem for the repository skills — every declaration parses and every declared field is written', (t) => {
    assert.deepEqual(report.problems, []);
    if (report.checked === 0) t.skip(`не к чему применить: ${report.notApplicable.join('; ')}`);
  });
  if (report.checked > 0) {
    for (const o of report.outcomes) {
      if (o.status === 'not_applicable') it(`${o.skill} → ${o.journal} is compared against adapter rows`, (t) => { t.skip(o.reason); });
    }
  }
});
