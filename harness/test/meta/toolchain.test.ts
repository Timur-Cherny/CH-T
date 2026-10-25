// INVARIANT R9: TypeScript для гейтов и проверок берётся из тулчейна харнесса по TOOLCHAIN.lock, а не из чужого
// рабочего дерева. Молча ломалось: пин вёл в удалённый воркtree (дважды — eng-release-147 в тестах и
// conn-devops-deferrer в harness.env), 68 тестов краснели, а живые гейты отвечали unknown в каждой сессии.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { sandbox, HARNESS_ROOT } from '../_env.ts';
import { readLock, resolveTypescript, verifyTypescript, toolchainDir, toolchainRoot, typescriptEntry, INSTALLED_MARKER } from '../../src/toolchain.ts';
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

const pkgJson = (version: string): Buffer => Buffer.from(JSON.stringify({ version }));
const TS_FILES = ['package.json', 'lib/typescript.js', 'lib/typescript.d.ts', 'lib/lib.*.d.ts'];

function fakeRoot(name: string, tarballs: { ts: Buffer; node: Buffer; undici: Buffer }, entryBody: Buffer, nodeVersion = '24.0.0'): string {
  const root = join(sb.dir, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'TOOLCHAIN.lock'), JSON.stringify({
    typescript: { version: '0.0.1', tarball: 'https://registry.invalid/ts.tgz', integrity: integrityOf(tarballs.ts), entry: 'node_modules/typescript/lib/typescript.js', entry_sha256: sha256(entryBody), files: TS_FILES },
    types: {
      '@types/node': { version: nodeVersion, tarball: 'https://registry.invalid/node.tgz', integrity: integrityOf(tarballs.node) },
      'undici-types': { version: '7.0.0', tarball: 'https://registry.invalid/undici.tgz', integrity: integrityOf(tarballs.undici) },
    },
  }));
  return root;
}
const serve = (byUrl: Record<string, Buffer>, status = 200): typeof fetch => (async (url: string) => {
  const name = String(url).replace('https://registry.invalid/', '').replace('.tgz', '');
  return byUrl[name] ? new Response(byUrl[name], { status }) : new Response('nope', { status: 404 });
}) as typeof fetch;

describe('TOOLCHAIN.lock', () => {
  it('pins an exact version, the tarball integrity and the sha256 of the entry', () => {
    const t = readLock(HARNESS_ROOT).typescript;
    assert.match(t.version, /^\d+\.\d+\.\d+$/);
    assert.match(t.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    assert.equal(t.entry, 'node_modules/typescript/lib/typescript.js');
    assert.match(t.entry_sha256, /^[0-9a-f]{64}$/);
  });
  it('ships the declarations a type check needs: typescript.d.ts, the lib.*.d.ts and @types/node with its undici-types', () => {
    const lock = readLock(HARNESS_ROOT);
    assert.ok(lock.typescript.files?.includes('lib/typescript.d.ts'));
    assert.ok(lock.typescript.files?.includes('lib/lib.*.d.ts'));
    for (const name of ['@types/node', 'undici-types']) {
      assert.match(lock.types[name]?.version ?? '', /^\d+\.\d+\.\d+$/, name);
      assert.match(lock.types[name].integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, name);
    }
  });
  it('pins @types/node to the major of the Node the harness runs on', () => {
    assert.equal(readLock(HARNESS_ROOT).types['@types/node'].version.split('.')[0], process.versions.node.split('.')[0]);
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
  const tsTgz = gzipSync(archive(
    tarEntry('package/package.json', pkgJson('0.0.1')), tarEntry('package/lib/typescript.js', body), tarEntry('package/lib/typescript.d.ts', Buffer.from('export {};\n')),
    tarEntry('package/lib/lib.es5.d.ts', Buffer.from('interface Array<T> {}\n')), tarEntry('package/lib/lib.es2024.d.ts', Buffer.from('\n')), tarEntry('package/lib/tsc.js', Buffer.from('cli')),
  ));
  const nodeTgz = gzipSync(archive(tarEntry('node/package.json', pkgJson('24.0.0')), tarEntry('node/index.d.ts', Buffer.from("declare module 'node:fs' {}\n"))));
  const undiciTgz = gzipSync(archive(tarEntry('package/package.json', pkgJson('7.0.0')), tarEntry('package/index.d.ts', Buffer.from('export {};\n'))));
  const tarballs = { ts: tsTgz, node: nodeTgz, undici: undiciTgz };
  const registry = serve({ ts: tsTgz, node: nodeTgz, undici: undiciTgz });

  it('lays the selected TypeScript files and every types package out as node_modules of the lock tree, the marker last', async () => {
    const root = fakeRoot('ok', tarballs, body);
    const env = { CLAUDE_HARNESS_TOOLCHAIN: join(sb.dir, 'tc-ok') };
    const path = await install(env, registry, root);
    const tree = toolchainRoot(env, root)!;
    assert.equal(path, join(tree, 'node_modules', 'typescript', 'lib', 'typescript.js'));
    assert.equal(readFileSync(path, 'utf8'), body.toString());
    for (const rel of ['typescript/lib/typescript.d.ts', 'typescript/lib/lib.es5.d.ts', 'typescript/lib/lib.es2024.d.ts', '@types/node/index.d.ts', '@types/node/package.json', 'undici-types/index.d.ts']) {
      assert.ok(existsSync(join(tree, 'node_modules', rel)), rel);
    }
    assert.equal(existsSync(join(tree, 'node_modules', 'typescript', 'lib', 'tsc.js')), false);
    assert.ok(existsSync(join(tree, INSTALLED_MARKER)));
    assert.deepEqual(verifyTypescript(env, root), { ok: true, path });
  });
  it('writes nothing at all when any package tarball differs from its lock integrity — not even TypeScript', async () => {
    const root = fakeRoot('bad-integrity', tarballs, body);
    const env = { CLAUDE_HARNESS_TOOLCHAIN: join(sb.dir, 'tc-bad') };
    const evil = gzipSync(archive(tarEntry('node/index.d.ts', Buffer.from('evil'))));
    await assert.rejects(install(env, serve({ ts: tsTgz, node: evil, undici: undiciTgz }), root), /integrity @types\/node/);
    assert.equal(existsSync(toolchainRoot(env, root)!), false);
    assert.equal(resolveTypescript(env, root).path, null);
  });
  it('rejects a registry error and an archive missing a selected file', async () => {
    const root = fakeRoot('errors', tarballs, body);
    await assert.rejects(install({ CLAUDE_HARNESS_TOOLCHAIN: join(sb.dir, 'tc-404') }, serve({ ts: tsTgz, node: nodeTgz }), root), /404 на https:\/\/registry\.invalid\/undici\.tgz/);
    const noLibs = gzipSync(archive(tarEntry('package/package.json', pkgJson('0.0.1')), tarEntry('package/lib/typescript.js', body), tarEntry('package/lib/typescript.d.ts', Buffer.from('export {};\n'))));
    const root2 = fakeRoot('no-libs', { ...tarballs, ts: noLibs }, body);
    await assert.rejects(install({ CLAUDE_HARNESS_TOOLCHAIN: join(sb.dir, 'tc-none') }, serve({ ts: noLibs, node: nodeTgz, undici: undiciTgz }), root2), /в архиве typescript нет lib\/lib\.\*\.d\.ts/);
  });
  it('reports an install that never finished: the entry matches the lock but the marker is missing', async () => {
    const root = fakeRoot('unfinished', tarballs, body);
    const env = { CLAUDE_HARNESS_TOOLCHAIN: join(sb.dir, 'tc-unfinished') };
    await install(env, registry, root);
    rmSync(join(toolchainRoot(env, root)!, INSTALLED_MARKER));
    const v = verifyTypescript(env, root);
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /установка не завершена/);
  });
  it('gives a changed types pin its own tree — a worktree with another lock never reuses a stale one', () => {
    const env = { CLAUDE_HARNESS_TOOLCHAIN: join(sb.dir, 'tc-pins') };
    const a = fakeRoot('pin-a', tarballs, body, '24.0.0');
    const b = fakeRoot('pin-b', tarballs, body, '24.0.1');
    assert.notEqual(toolchainRoot(env, a), toolchainRoot(env, b));
  });
  it('reports a planted entry that does not match the lock sha256', () => {
    const root = fakeRoot('mismatch', tarballs, body);
    const env = { CLAUDE_HARNESS_TOOLCHAIN: join(sb.dir, 'tc-mismatch') };
    const entry = typescriptEntry(env, root)!;
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, 'tampered');
    const v = verifyTypescript(env, root);
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
