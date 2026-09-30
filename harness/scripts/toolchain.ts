// CLI тулчейна харнесса. --install: tarball из npm-реестра → integrity из TOOLCHAIN.lock → в каталог тулчейна
// извлекаются только entry и package.json → sha256 entry сверяется с замком. --check: только сверка.
// Без child_process (К5): загрузка через fetch, распаковка через zlib и разбор ustar здесь же.
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { dirname, join, normalize, isAbsolute } from 'node:path';
import { readLock, toolchainDir, verifyTypescript, HARNESS_DIR } from '../src/toolchain.ts';
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
  const t = readLock(root).typescript;
  const dir = toolchainDir(env);
  if (!dir) throw new Error('нет HOME и CLAUDE_HARNESS_TOOLCHAIN — некуда ставить тулчейн');
  const res = await fetchImpl(t.tarball, { signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`реестр ответил ${res.status} на ${t.tarball}`);
  const tgz = Buffer.from(await res.arrayBuffer());
  const got = integrityOf(tgz);
  if (got !== t.integrity) throw new Error(`integrity tarball не совпадает с TOOLCHAIN.lock: ${got.slice(0, 24)}… ≠ ${t.integrity.slice(0, 24)}…`);
  const files = untar(gunzipSync(tgz));
  const target = join(dir, `typescript@${t.version}`);
  for (const rel of [t.entry, 'package/package.json']) {
    const body = files.get(normalize(rel));
    if (!body) throw new Error(`в архиве нет ${rel}`);
    const dest = join(target, rel);
    mkdirSync(dirname(dest), { recursive: true });
    // Tmp per process: two SessionStarts in one HOME install at once, and a shared tmp could be renamed half-written.
    writeFileSync(`${dest}.${process.pid}.tmp`, body);
    renameSync(`${dest}.${process.pid}.tmp`, dest);
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
