// INVARIANT R9: TypeScript для гейтов и проверок берётся из тулчейна харнесса по TOOLCHAIN.lock, а не из чужого
// рабочего дерева. Молча ломалось: пин вёл в удалённый воркtree (дважды — eng-release-147 в тестах и
// conn-devops-deferrer в harness.env), 68 тестов краснели, а живые гейты отвечали unknown в каждой сессии.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { sandbox, HARNESS_ROOT } from '../_env.ts';
import { readLock, resolveTypescript, verifyTypescript, toolchainDir } from '../../src/toolchain.ts';
import { untar, install, integrityOf } from '../../scripts/toolchain.ts';
import { loadTypescript } from '../../src/parsers/ts.ts';

const sb = sandbox('harness-toolchain-');
after(() => sb.cleanup());

function tarEntry(name: string, body: Buffer, opts: { type?: string; prefix?: string } = {}): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write(opts.type ?? '0', 156);
  h.write('ustar\0', 257);
  if (opts.prefix) h.write(opts.prefix, 345, 155, 'utf8');
  return Buffer.concat([h, body, Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length)]);
}
const archive = (...entries: Buffer[]): Buffer => Buffer.concat([...entries, Buffer.alloc(1024)]);
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

function fakeRoot(name: string, entryBody: Buffer, tgz: Buffer): string {
  const root = join(sb.dir, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'TOOLCHAIN.lock'), JSON.stringify({ typescript: {
    version: '0.0.1', tarball: 'https://registry.invalid/t.tgz', integrity: integrityOf(tgz),
    entry: 'package/lib/typescript.js', entry_sha256: sha256(entryBody),
  } }));
  return root;
}
const serve = (body: Buffer, status = 200): typeof fetch => (async () => new Response(body, { status })) as typeof fetch;

describe('TOOLCHAIN.lock', () => {
  it('pins an exact version, the tarball integrity and the sha256 of the entry', () => {
    const t = readLock(HARNESS_ROOT).typescript;
    assert.match(t.version, /^\d+\.\d+\.\d+$/);
    assert.match(t.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    assert.equal(t.entry, 'package/lib/typescript.js');
    assert.match(t.entry_sha256, /^[0-9a-f]{64}$/);
  });
});

describe('untar', () => {
  it('extracts regular files, joins the ustar prefix and skips directories', () => {
    const files = untar(archive(tarEntry('package/', Buffer.alloc(0), { type: '5' }), tarEntry('a.js', Buffer.from('A'), { prefix: 'package/lib' })));
    assert.deepEqual([...files.keys()], ['package/lib/a.js']);
    assert.equal(files.get('package/lib/a.js')!.toString(), 'A');
  });
  it('applies a pax path override to the next entry', () => {
    const pax = Buffer.from('30 path=package/lib/long-name.js\n');
    const files = untar(archive(tarEntry('PaxHeader', pax, { type: 'x' }), tarEntry('short', Buffer.from('L'))));
    assert.equal(files.get('package/lib/long-name.js')!.toString(), 'L');
  });
  it('refuses a path that climbs out of the archive root or is absolute — not a silent skip', () => {
    assert.throws(() => untar(archive(tarEntry('../evil.js', Buffer.from('x')))), /небезопасный путь/);
    assert.throws(() => untar(archive(tarEntry('/etc/evil', Buffer.from('x')))), /небезопасный путь/);
  });
});

describe('install', () => {
  const body = Buffer.from('module.exports = { createSourceFile() {} };\n');
  const tgz = gzipSync(archive(tarEntry('package/package.json', Buffer.from('{"version":"0.0.1"}')), tarEntry('package/lib/typescript.js', body)));

  it('writes the entry only when the tarball integrity and the entry sha256 match the lock', async () => {
    const root = fakeRoot('ok', body, tgz);
    const env = { CLAUDE_HARNESS_TOOLCHAIN: join(sb.dir, 'tc-ok') };
    const path = await install(env, serve(tgz), root);
    assert.equal(readFileSync(path, 'utf8'), body.toString());
    assert.deepEqual(verifyTypescript(env, root), { ok: true, path });
  });
  it('rejects a tarball whose integrity differs from the lock and writes nothing', async () => {
    const root = fakeRoot('bad-integrity', body, tgz);
    const env = { CLAUDE_HARNESS_TOOLCHAIN: join(sb.dir, 'tc-bad') };
    await assert.rejects(install(env, serve(gzipSync(archive(tarEntry('package/lib/typescript.js', Buffer.from('evil'))))), root), /integrity/);
    assert.equal(resolveTypescript(env, root).path, null);
  });
  it('rejects a registry error and an archive without the entry', async () => {
    const root = fakeRoot('errors', body, tgz);
    await assert.rejects(install({ CLAUDE_HARNESS_TOOLCHAIN: join(sb.dir, 'tc-404') }, serve(Buffer.from('nope'), 404), root), /404/);
    const empty = gzipSync(archive(tarEntry('package/package.json', Buffer.from('{}'))));
    const root2 = fakeRoot('no-entry', body, empty);
    await assert.rejects(install({ CLAUDE_HARNESS_TOOLCHAIN: join(sb.dir, 'tc-none') }, serve(empty), root2), /в архиве нет package\/lib\/typescript\.js/);
  });
  it('reports a planted entry that does not match the lock sha256', () => {
    const root = fakeRoot('mismatch', body, tgz);
    const dir = join(sb.dir, 'tc-mismatch');
    mkdirSync(join(dir, 'typescript@0.0.1', 'package', 'lib'), { recursive: true });
    writeFileSync(join(dir, 'typescript@0.0.1', 'package', 'lib', 'typescript.js'), 'tampered');
    const v = verifyTypescript({ CLAUDE_HARNESS_TOOLCHAIN: dir }, root);
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /не совпадает с TOOLCHAIN\.lock/);
  });
});

describe('resolution', () => {
  it('has no toolchain directory without HOME and CLAUDE_HARNESS_TOOLCHAIN — a bare env stays hermetic', () => {
    const r = resolveTypescript({});
    assert.equal(r.path, null);
    assert.match((r as { reason: string }).reason, /нет HOME и CLAUDE_HARNESS_TOOLCHAIN/);
  });
  it('names both the rotten pin and the missing toolchain when neither loads', () => {
    const loaded = loadTypescript(null, { CLAUDE_HARNESS_TS: '/gone/worktree/typescript.js', HOME: sb.home });
    assert.equal(loaded.ts, null);
    const reason = (loaded as { missing_reason: string }).missing_reason;
    assert.match(reason, /CLAUDE_HARNESS_TS не загружается/);
    assert.match(reason, /тулчейн харнесса: typescript@/);
  });
});

describe('live toolchain', () => {
  it('is installed and matches TOOLCHAIN.lock — otherwise every TS-dependent gate answers unknown', () => {
    const v = verifyTypescript(process.env);
    assert.ok(v.ok, v.ok ? '' : `${v.reason}`);
  });
  it('replaces a rotten CLAUDE_HARNESS_TS pin instead of answering unknown', () => {
    const loaded = loadTypescript(null, { CLAUDE_HARNESS_TS: '/gone/worktree/typescript.js', CLAUDE_HARNESS_TOOLCHAIN: toolchainDir(process.env) ?? '' });
    assert.ok(loaded.ts, 'ts' in loaded && loaded.ts ? '' : (loaded as { missing_reason: string }).missing_reason);
    assert.equal(typeof loaded.ts!.createSourceFile, 'function');
  });
});
