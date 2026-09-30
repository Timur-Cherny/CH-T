// INVARIANT: метрики формы кода считаются по AST и по байтам, детерминированно и без побочных эффектов: тот же
// каталог даёт те же числа, сгенерированное (node_modules, dist, *.d.ts) исключено, JSX разбирается как JSX.
// Без этого ответ «как пишут агенты» держится впечатлением, а оно не воспроизводится.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from '../_env.ts';
import { TS_PATH } from '../checks/_repo.ts';
import { loadTypescript } from '../../src/parsers/ts.ts';
import { measure, listSources, render } from '../../scripts/code-metrics.ts';

const sb = sandbox('harness-metrics-');
after(() => sb.cleanup());
const loaded = loadTypescript(null, { CLAUDE_HARNESS_TS: TS_PATH, HOME: '/nonexistent-home' });

const SHARED = ['const total = quantity * price;', 'const discounted = total - discount;', 'const rounded = Math.round(discounted * 100) / 100;', 'return rounded + shippingFee;', 'const unusedButLong = rounded + 1;'].join('\n');
function fixture(): string {
  const root = join(sb.dir, 'proj');
  for (const d of ['src/deep', 'node_modules/pkg', 'dist']) mkdirSync(join(root, d), { recursive: true });
  const bigBody = Array.from({ length: 43 }, (_, i) => `  x = x + ${i};`).join('\n');
  writeFileSync(join(root, 'src', 'a.ts'), `export function big(x: number, y: number): number {\n${bigBody}\n  return x + y;\n}\nexport function calc(quantity: number, price: number, discount: number, shippingFee: number): number {\n${SHARED}\n}\nconst v = 1 as unknown as number;\nconst ab = 2;\nlet z = (v as { q?: number }).q!;\nconst longLine = '${'a'.repeat(150)}';\nexport const use = [v, ab, z, longLine];\n`);
  writeFileSync(join(root, 'src', 'deep', 'b.ts'), Buffer.concat([Buffer.from(`export function calc2(quantity: number, price: number, discount: number, shippingFee: number): number {\n${SHARED}\n}\nexport const SENTINEL = '`), Buffer.from([0]), Buffer.from(`url';\n`)]));
  writeFileSync(join(root, 'src', 'c.tsx'), 'export const View = ({ items }: { items: string[] }) => <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>;\n');
  writeFileSync(join(root, 'src', 'types.d.ts'), 'declare const q: number;\n');
  writeFileSync(join(root, 'node_modules', 'pkg', 'x.ts'), 'export function ignored() { return 1; }\n');
  writeFileSync(join(root, 'dist', 'a.ts'), 'export function ignored() { return 1; }\n');
  return join(root, 'src');
}

describe('code-metrics', () => {
  it('has a working typescript — without it every number below would be vacuous', () => assert.ok(loaded.ts, 'missing_reason' in loaded ? loaded.missing_reason : ''));
  it('counts long functions, casts, short names, long lines, cross-file duplicates and invisible bytes; skips generated code; reads JSX', () => {
    const src = fixture();
    assert.deepEqual(listSources(src).map((f) => f.slice(src.length + 1)), ['a.ts', 'c.tsx', 'deep/b.ts'], 'd.ts, node_modules и dist исключены, tsx включён');
    const m = measure(src, loaded.ts!);
    assert.equal(m.files, 3);
    assert.deepEqual(m.longFunctions.map((f) => [f.name, f.lines >= 40, f.params]), [['big', true, 2]]);
    assert.equal(m.casts, 3, 'два as в одной цепочке плюс приведение перед non-null');
    assert.equal(m.nonNull, 1);
    assert.ok(m.shortNames >= 3, `короткие имена: v, ab, z — насчитано ${m.shortNames}`);
    assert.equal(m.longLines, 1);
    assert.equal(m.duplicates.length, 1, JSON.stringify(m.duplicates));
    assert.deepEqual(m.duplicates[0].files.map((w) => w.split(':')[0]).sort(), ['a.ts', 'deep/b.ts']);
    assert.ok(m.duplicates[0].lines >= 5, `run дубля склеен: ${m.duplicates[0].lines}`);
    assert.deepEqual(m.oddBytes.map((b) => [b.file, b.byte]), [['deep/b.ts', 0]]);
    assert.ok(m.functions >= 4, 'стрелки внутри JSX тоже функции');
    const text = render(m, 5);
    assert.match(text, /функций длиннее порога 1 из/);
    assert.match(text, /невидимый байт 0x0 в deep\/b\.ts/);
  });
  it('is deterministic: two runs over the same tree give the same numbers', () => {
    const src = fixture();
    const a = JSON.stringify(measure(src, loaded.ts!)); const b = JSON.stringify(measure(src, loaded.ts!));
    assert.equal(a, b);
  });
});
