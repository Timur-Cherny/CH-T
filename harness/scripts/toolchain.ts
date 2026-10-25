// CLI of the harness toolchain. --install: every package of TOOLCHAIN.lock from the npm registry, each tarball checked
// against its lock integrity before anything is written, then the package's `files` (all files when absent) go to
// node_modules/<name>/ of the lock's tree, the install marker last, and the entry sha256 is checked. --check: the check
// only. No child_process (ADR v4, K5): download by fetch, unpacking by zlib and the ustar reader here.
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { dirname, join, normalize, isAbsolute } from 'node:path';
import { readLock, lockDigest, toolchainRoot, verifyTypescript, HARNESS_DIR, INSTALLED_MARKER, type LockedPackage } from '../src/toolchain.ts';
import { isMainModule } from '../src/is-main.ts';

export function integrityOf(buf: Buffer): string {
  return 'sha512-' + createHash('sha512').update(buf).digest('base64');
}

/** Обычные файлы ustar-архива: путь → содержимое. Путь, выходящий за корень архива, — ошибка, а не пропуск. */
export function untar(tar: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let off = 0;
  let paxPath: string | null = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (start: number, len: number): string => h.subarray(start, start + len).toString('utf8').replace(/\0[\s\S]*$/, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const prefix = field(345, 155);
    const name = paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    paxPath = null;
    const body = tar.subarray(off + 512, off + 512 + size);
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      paxPath = m ? m[1] : null;
    } else if (type === '0') {
      const rel = normalize(name);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new Error(`небезопасный путь в архиве: ${name}`);
      out.set(rel, Buffer.from(body));
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

export async function install(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch, root: string = HARNESS_DIR): Promise<string> {
  const lock = readLock(root);
  const tree = toolchainRoot(env, root);
  if (!tree) throw new Error('нет HOME и CLAUDE_HARNESS_TOOLCHAIN — некуда ставить тулчейн');
  const writes: Array<[string, Buffer]> = [];
  const packages: Array<[string, LockedPackage]> = [['typescript', lock.typescript], ...Object.entries(lock.types)];
  for (const [name, pkg] of packages) {
    const res = await fetchImpl(pkg.tarball);
    if (!res.ok) throw new Error(`реестр ответил ${res.status} на ${pkg.tarball}`);
    const tgz = Buffer.from(await res.arrayBuffer());
    const got = integrityOf(tgz);
    if (got !== pkg.integrity) throw new Error(`integrity ${name} не совпадает с TOOLCHAIN.lock: ${got.slice(0, 24)}… ≠ ${pkg.integrity.slice(0, 24)}…`);
    const inPackage = new Map<string, Buffer>();
    for (const [rel, body] of untar(gunzipSync(tgz))) { const cut = rel.indexOf('/'); if (cut > 0) inPackage.set(rel.slice(cut + 1), body); }
    const picked = new Map<string, Buffer>(pkg.files ? [] : inPackage);
    for (const pattern of pkg.files ?? []) {
      const glob = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
      const hits = [...inPackage].filter(([rel]) => glob.test(rel));
      if (!hits.length) throw new Error(`в архиве ${name} нет ${pattern}`);
      for (const [rel, body] of hits) picked.set(rel, body);
    }
    for (const [rel, body] of picked) writes.push([join(tree, 'node_modules', name, rel), body]);
  }
  for (const [dest, body] of [...writes, [join(tree, INSTALLED_MARKER), Buffer.from(`${lockDigest(root)}\n`)] as [string, Buffer]]) {
    const tmp = `${dest}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(tmp, body);
    renameSync(tmp, dest);
  }
  const v = verifyTypescript(env, root);
  if (!v.ok) throw new Error(v.reason);
  return v.path;
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === '--install') {
    install(process.env).then(
      (p) => { process.stdout.write(`${p}\n`); },
      (e) => { process.stderr.write(`${(e as Error).message}\n`); process.exitCode = 1; },
    );
  } else if (cmd === undefined || cmd === '--check') {
    const v = verifyTypescript(process.env);
    if (v.ok) process.stdout.write(`${v.path}\n`);
    else { process.stderr.write(`${v.reason}\n`); process.exitCode = 1; }
  } else {
    process.stderr.write('использование: ~/.claude/harness/bin/run scripts/toolchain.ts [--check|--install]\n');
    process.exitCode = 64;
  }
}
