// INVARIANT: the public export is the committed state of the brain minus the manifest's exclusions; no exported file
// carries an identifier of the site (a manifest deny pattern or a token of the site config) or a raw control byte —
// any hit fails the export before a byte is written; the out dir is never the brain, its ancestor or $HOME.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../_env.ts';
import { build, configTokens, denyPatterns, main, prepareOut, readManifest, scan, selects, tracked } from '../../scripts/export.ts';
import type { Manifest, Tree } from '../../scripts/export.ts';

const sb = sandbox('harness-export-');
after(() => sb.cleanup());
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' };
const g = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf8' });
const MANIFEST: Manifest = {
  version: '9.9.9-test', include: ['harness/', 'agents/a.md'], exclude: ['harness/owner/'],
  templates: { 'README.md': 'harness/dist/README.md' }, settings: { from: 'harness/hooks.json', comment: 'public' },
  deny: ['acme-corp'],
};

function brain(name: string, files: Record<string, string>): string {
  const root = join(sb.dir, name);
  const all: Record<string, string> = {
    'harness/src/a.ts': 'export const a = 1;\n', 'harness/owner/decision.json': '{"remote":"git.corp.test/acme-corp/brain"}\n',
    'harness/package.json': '{"name":"old-name","type":"module"}\n', 'harness/hooks.json': '{"_comment":"private","hooks":{"Stop":[]}}\n',
    'harness/dist/README.md': '# public\n', 'agents/a.md': 'agent\n', 'agents/b.md': 'private agent\n',
    'harness.config.json': JSON.stringify({ protectedBranches: ['corp/main'], ownerHosts: ['git.corp.test'] }),
    'harness.export.json': JSON.stringify(MANIFEST), ...files,
  };
  for (const [p, c] of Object.entries(all)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); }
  g(root, 'init', '-q'); g(root, 'add', '-A'); g(root, 'commit', '-qm', 'base');
  return root;
}
const run = (root: string, out: string, ...flags: string[]): number => main(['--out', out, '--brain', root, ...flags], { HOME: sb.home, PATH: process.env.PATH });

describe('export', () => {
  it('takes site tokens from config values, not from keys, comments or free text', () => {
    const t = configTokens({ protectedBranches: ['corp/main'], ownerHosts: ['git.corp.test'], _comment: 'x/y.z-notes', workDocs: { cwd: '(svc-one|svc-two)', text: 'a work-doc reminder' }, dataBoundary: { configTables: ['plain', 'schema_table'] } });
    assert.deepEqual(t, ['corp/main', 'git.corp.test', 'schema_table', 'svc-one', 'svc-two']);
  });

  it('selects include dirs and exact paths minus excludes', () => {
    assert.deepEqual(['harness/src/x.ts', 'harness/owner/y.json', 'agents/a.md', 'agents/b.md'].map((p) => selects(p, MANIFEST)), [true, false, true, false]);
  });

  it('finds a deny pattern in any case, a raw control byte in text, and skips binaries', () => {
    const tree: Tree = { files: new Map([
      ['a.md', { body: Buffer.from('ok\nsee ACME-Corp here\n'), exec: false }],
      ['b.ts', { body: Buffer.from('const x = "\u0000";\n'), exec: false }],
      ['c.wasm', { body: Buffer.from([0, 1, 2]), exec: false }],
    ]) };
    const r = scan(tree, denyPatterns(MANIFEST, []));
    assert.deepEqual(r.leaks.map((l) => [l.path, l.line]), [['a.md', 2]]);
    assert.deepEqual(r.control, ['b.ts']);
  });

  it('refuses an out dir that is the brain, holds it or is HOME; cleans only a previous export or a --replace target', () => {
    const root = join(sb.dir, 'guard', 'brain'); mkdirSync(root, { recursive: true });
    assert.throws(() => prepareOut(root, root, true, sb.home), /мозг/);
    assert.throws(() => prepareOut(dirname(root), root, true, sb.home), /предок/);
    assert.throws(() => prepareOut(sb.home, root, true, sb.home), /HOME/);
    const out = join(sb.dir, 'guard', 'out'); mkdirSync(join(out, '.git'), { recursive: true }); writeFileSync(join(out, 'keep.txt'), 'x');
    assert.throws(() => prepareOut(out, root, false, sb.home), /--replace/);
    writeFileSync(join(out, 'EXPORT.json'), '{}');
    prepareOut(out, root, false, sb.home);
    assert.deepEqual([existsSync(join(out, 'keep.txt')), existsSync(join(out, '.git'))], [false, true]);
  });

  it('writes the committed tree: templates at the root, settings from the hooks, package renamed, private paths absent', () => {
    const root = brain('clean', {});
    const out = join(sb.dir, 'out-clean');
    assert.equal(run(root, out), 0);
    const meta = JSON.parse(readFileSync(join(out, 'EXPORT.json'), 'utf8')) as { version: string; source: string; files: Record<string, string> };
    assert.equal(meta.version, '9.9.9-test');
    assert.equal(meta.source, g(root, 'rev-parse', 'HEAD').trim());
    assert.deepEqual(Object.keys(meta.files).sort(), ['README.md', 'agents/a.md', 'harness/hooks.json', 'harness/package.json', 'harness/src/a.ts', 'settings.json']);
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'settings.json'), 'utf8')), { _comment: 'public', hooks: { Stop: [] } });
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'harness', 'package.json'), 'utf8')), { name: 'claude-harness', version: '9.9.9-test', type: 'module' });
    assert.equal(existsSync(join(out, 'harness', 'owner')), false);
  });

  it('stops on a leak — a config token or a deny pattern in an exported file — and writes nothing', () => {
    const root = brain('leaky', { 'harness/src/b.ts': '// pushes to corp/main\n' });
    const out = join(sb.dir, 'out-leaky');
    assert.equal(run(root, out), 1);
    assert.equal(existsSync(out), false);
  });

  it('stops on an uncommitted change in its scope unless --allow-dirty, which marks the source (both sides)', () => {
    const root = brain('dirty', {});
    writeFileSync(join(root, 'harness', 'src', 'a.ts'), 'export const a = 2;\n');
    assert.equal(run(root, join(sb.dir, 'out-dirty')), 1);
    assert.equal(run(root, join(sb.dir, 'out-dirty2'), '--allow-dirty'), 0);
    assert.match((JSON.parse(readFileSync(join(sb.dir, 'out-dirty2', 'EXPORT.json'), 'utf8')) as { source: string }).source, /\+dirty$/);
    writeFileSync(join(root, 'agents', 'b.md'), 'changed private agent\n');
    g(root, 'checkout', '--', 'harness/src/a.ts');
    assert.equal(run(root, join(sb.dir, 'out-dirty3')), 0, 'правка вне состава выгрузки её не останавливает');
  });

  // The scan runs only at export time, so a leak committed between two exports stayed silent until the next one
  // (26.09 clean, 29.09 — 109 hits). The suite checks the brain's own tree instead; in the exported tree there is
  // no private manifest and the check has nothing to judge.
  it('the brain exports clean: its tracked tree carries no deny pattern and no site-config token', (t) => {
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const manifestFile = join(root, 'harness.export.json');
    if (!existsSync(manifestFile)) { t.skip('нет приватного манифеста — это собранная выгрузка'); return; }
    const manifest = readManifest(manifestFile);
    const configFile = join(root, 'harness.config.json');
    const tokens = existsSync(configFile) ? configTokens(JSON.parse(readFileSync(configFile, 'utf8'))) : [];
    const { leaks, control } = scan(build(root, manifest, tracked(root)), denyPatterns(manifest, tokens));
    assert.deepEqual(leaks.map((l) => `${l.path}:${l.line} /${l.pattern}/`), []);
    assert.deepEqual(control, []);
  });
});
