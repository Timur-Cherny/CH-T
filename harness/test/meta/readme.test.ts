// README, по которому ставят и чинят контур, не ссылается в пустоту: каждая относительная ссылка ведёт на
// существующий файл, и ни одна не указывает номер строки — `file.ts:NN` гниёт с первой правкой файла (аудит 25.09:
// 12 из 14 таких ссылок корневого README вели на пустые строки). Символ (`route()` в main.ts) переживает правку.
// В собранном дереве выгрузки тот же тест ловит ссылку на файл, который в дистрибутив не вошёл.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESS_ROOT } from '../_env.ts';

const REPO = join(HARNESS_ROOT, '..');
const DOCS: Array<[string, string]> = [
  [join(REPO, 'README.md'), REPO],
  [join(HARNESS_ROOT, 'README.md'), HARNESS_ROOT],
  [join(HARNESS_ROOT, 'dist', 'README.md'), REPO],
].filter(([doc]) => existsSync(doc)) as Array<[string, string]>;

function links(text: string): string[] {
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!).filter((t) => !/^(?:[a-z]+:|#)/i.test(t)).map((t) => t.split('#')[0]!);
}

describe('meta: README', () => {
  it('finds the documents it guards', () => assert.ok(DOCS.length >= 2, DOCS.map(([d]) => d).join(', ')));

  for (const [doc, base] of DOCS) {
    const text = readFileSync(doc, 'utf8');
    const name = doc.slice(REPO.length + 1);
    it(`${name}: every relative link resolves`, () => {
      const dead = links(text).filter((t) => !existsSync(join(base, t)));
      assert.deepEqual(dead, []);
    });
    it(`${name}: no file:line references`, () => {
      const refs = [...text.matchAll(/`[^`\s]+\.[a-z]{1,4}:\d+(?:-\d+)?`|\([^()\s]+\.[a-z]{1,4}:\d+\)/g)].map((m) => m[0]);
      assert.deepEqual(refs, []);
    });
  }

  it('recognises a dead link and a line reference in a fixture', () => {
    assert.deepEqual(links('[a](x.md) [b](https://e.x) [c](#s) [d](y/z.md#h)'), ['x.md', 'y/z.md']);
    assert.equal(/`[^`\s]+\.[a-z]{1,4}:\d+(?:-\d+)?`/.test('см. `harness/src/emit.ts:49`'), true);
  });
});
