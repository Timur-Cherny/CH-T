// INVARIANT: no config file — generic defaults and silence where a behaviour means nothing unconfigured.
// INVARIANT: a file that exists and does not read never throws and is never silent: the field falls back to its
// default and `problem` names it, so the protecting gates answer unknown instead of guarding the defaults.
// INVARIANT: a variable name from the config reaches `sh -c` only in the form [A-Za-z_][A-Za-z0-9_]*.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, HARNESS_ROOT } from './_env.ts';
import { loadConfig, configPath, resetConfigCache } from '../src/config.ts';

function withFile(content: string | null, where: 'home' | 'explicit'): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const sb = sandbox('harness-config-');
  const path = where === 'home' ? join(sb.home, '.claude', 'harness.config.json') : join(sb.dir, 'explicit.json');
  if (content !== null) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  resetConfigCache();
  const env: NodeJS.ProcessEnv = where === 'home' ? { HOME: sb.home } : { HOME: sb.home, CLAUDE_HARNESS_CONFIG: path };
  return { env, cleanup: () => { sb.cleanup(); resetConfigCache(); } };
}

describe('config', () => {
  it('protects main, guards no host and watches nothing when no config file exists — and reports no problem', () => {
    const c = withFile(null, 'home');
    const cfg = loadConfig(c.env);
    assert.deepEqual(cfg.protectedBranches, ['main']);
    assert.deepEqual([cfg.ownerHosts, cfg.integrationBranches, cfg.freshness.repoVars, cfg.dataBoundary.configTables], [[], [], [], []]);
    assert.equal(cfg.workDocs, undefined);
    assert.equal(cfg.shellPaths, undefined);
    assert.equal(cfg.problem, null);
    c.cleanup();
  });

  it('reads every site field from the file', () => {
    const c = withFile(JSON.stringify({
      protectedBranches: ['product/main'], integrationBranches: ['product/dev'], ownerHosts: ['git.example.com'],
      shellPaths: { file: '.config/paths.sh', vars: ['APP_ENGINE', 'APP_FE'] },
      freshness: { vaultVar: 'APP_VAULT', repoVars: ['APP_ENGINE'], trackerRel: 'docs/TRACKER.md' },
      dataBoundary: { configTables: ['app_settings'] }, workDocs: { cwd: 'foo', text: 'bar' }, vaultRel: 'Docs/vault',
    }), 'home');
    const cfg = loadConfig(c.env);
    assert.deepEqual(cfg.protectedBranches, ['product/main']);
    assert.deepEqual(cfg.integrationBranches, ['product/dev']);
    assert.deepEqual(cfg.ownerHosts, ['git.example.com']);
    assert.deepEqual(cfg.shellPaths, { file: '.config/paths.sh', vars: ['APP_ENGINE', 'APP_FE'] });
    assert.deepEqual(cfg.freshness, { vaultVar: 'APP_VAULT', repoVars: ['APP_ENGINE'], trackerRel: 'docs/TRACKER.md' });
    assert.deepEqual(cfg.dataBoundary.configTables, ['app_settings']);
    assert.deepEqual(cfg.workDocs, { cwd: 'foo', text: 'bar' });
    assert.equal(cfg.vaultRel, 'Docs/vault');
    assert.equal(cfg.problem, null);
    c.cleanup();
  });

  it('names broken JSON as a problem instead of throwing on every event', () => {
    const c = withFile('{ not json', 'home');
    const cfg = loadConfig(c.env);
    assert.deepEqual(cfg.protectedBranches, ['main']);
    assert.match(cfg.problem ?? '', /не JSON-объект/);
    c.cleanup();
  });

  it('keeps the default for a field of the wrong shape and names the field (both sides)', () => {
    const c = withFile(JSON.stringify({ protectedBranches: 'main', workDocs: { cwd: 'foo' }, vaultRel: 42, ownerHosts: ['git.example.com'] }), 'home');
    const cfg = loadConfig(c.env);
    assert.deepEqual(cfg.protectedBranches, ['main'], 'строка вместо массива — это не список веток');
    assert.equal(cfg.workDocs, undefined, 'workDocs без text бесполезен: напоминать нечем');
    assert.equal(cfg.vaultRel, undefined);
    assert.deepEqual(cfg.ownerHosts, ['git.example.com'], 'поле правильной формы читается и рядом с битым');
    assert.match(cfg.problem ?? '', /protectedBranches/);
    assert.match(cfg.problem ?? '', /workDocs/);
    assert.match(cfg.problem ?? '', /vaultRel/);
    c.cleanup();
  });

  it('refuses a variable name that is not a plain shell name — it would be code inside sh -c', () => {
    const c = withFile(JSON.stringify({ shellPaths: { file: 'p.sh', vars: ['OK', 'X; rm -rf ~'] }, freshness: { vaultVar: '$(id)', repoVars: ['A B'] } }), 'home');
    const cfg = loadConfig(c.env);
    assert.equal(cfg.shellPaths, undefined);
    assert.equal(cfg.freshness.vaultVar, undefined);
    assert.deepEqual(cfg.freshness.repoVars, []);
    assert.match(cfg.problem ?? '', /shellPaths\.vars/);
    c.cleanup();
  });

  it('reads freshness.sync only whole and well-formed: a bad remote or branch name moves no ref and is a problem', () => {
    const good = withFile(JSON.stringify({ freshness: { repoVars: ['A'], sync: { remote: 'source', branches: ['release/main', 'release/dev'] } } }), 'home');
    assert.deepEqual(loadConfig(good.env).freshness.sync, { remote: 'source', branches: ['release/main', 'release/dev'] });
    assert.equal(loadConfig(good.env).problem, null);
    good.cleanup();
    for (const sync of [{ remote: '-u', branches: ['main'] }, { remote: 'o', branches: ['a..b'] }, { remote: 'o', branches: ['--force'] }, { remote: 'o', branches: [] }, { branches: ['main'] }]) {
      const c = withFile(JSON.stringify({ freshness: { repoVars: ['A'], sync } }), 'home');
      const cfg = loadConfig(c.env);
      assert.equal(cfg.freshness.sync, undefined, JSON.stringify(sync));
      assert.match(cfg.problem ?? '', /freshness\.sync/);
      c.cleanup();
    }
  });

  it('treats an empty protected list as a problem, never as «nothing is protected»', () => {
    const c = withFile(JSON.stringify({ protectedBranches: [] }), 'home');
    const cfg = loadConfig(c.env);
    assert.deepEqual(cfg.protectedBranches, ['main']);
    assert.match(cfg.problem ?? '', /protectedBranches/);
    c.cleanup();
  });

  it('lets CLAUDE_HARNESS_CONFIG outrank the path under HOME', () => {
    const c = withFile(JSON.stringify({ protectedBranches: ['trunk'] }), 'explicit');
    assert.deepEqual(loadConfig(c.env).protectedBranches, ['trunk']);
    assert.equal(configPath(c.env), c.env.CLAUDE_HARNESS_CONFIG);
    c.cleanup();
  });

  it('reports an unreadable path that is not missing (a directory) as a problem', () => {
    const sb = sandbox('harness-config-');
    resetConfigCache();
    const cfg = loadConfig({ HOME: sb.home, CLAUDE_HARNESS_CONFIG: sb.dir });
    assert.match(cfg.problem ?? '', /не прочитан/);
    sb.cleanup(); resetConfigCache();
  });

  it('reads the shipped example without a problem — the template stays in step with the contract', () => {
    resetConfigCache();
    const cfg = loadConfig({ HOME: '/nonexistent', CLAUDE_HARNESS_CONFIG: join(HARNESS_ROOT, 'harness.config.example.json') });
    assert.equal(cfg.problem, null);
    assert.ok(cfg.ownerHosts.length && cfg.shellPaths && cfg.freshness.repoVars.length && cfg.dataBoundary.configTables.length && cfg.workDocs);
    resetConfigCache();
  });

  it('ranks an explicit CLAUDE_HARNESS_CONFIG over ~/.claude/harness.config.json', () => {
    const sb = sandbox('harness-config-rank-');
    mkdirSync(join(sb.home, '.claude'), { recursive: true });
    writeFileSync(join(sb.home, '.claude', 'harness.config.json'), JSON.stringify({ protectedBranches: ['home'] }));
    const explicit = join(sb.dir, 'explicit.json');
    writeFileSync(explicit, JSON.stringify({ protectedBranches: ['explicit'] }));
    resetConfigCache();
    assert.deepEqual(loadConfig({ HOME: sb.home }).protectedBranches, ['home']);
    resetConfigCache();
    assert.deepEqual(loadConfig({ HOME: sb.home, CLAUDE_HARNESS_CONFIG: explicit }).protectedBranches, ['explicit']);
    sb.cleanup(); resetConfigCache();
  });

  it('has no config path at all when HOME is unset — no read, no default file', () => {
    resetConfigCache();
    assert.equal(configPath({}), null);
    assert.deepEqual(loadConfig({}).protectedBranches, ['main']);
    assert.equal(loadConfig({}).problem, null);
  });
});
