// INVARIANT: список слов-триггеров один — bin/prefilter.regex (для шима) равен экспорту prefilters.ts (для роутера).
// Молча ломалось бы: шим отсекает команду, которую роутер считает опасной, или наоборот.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prefilterSource, PRE_BASH_REGEX } from '../../src/gates/prefilters.ts';
import { heavyCommand } from '../../src/gates/resource.ts';
import { HARNESS_ROOT } from '../_env.ts';

describe('prefilter', () => {
  it('keeps bin/prefilter.regex byte-equal to prefilters.ts', () => {
    assert.equal(readFileSync(join(HARNESS_ROOT, 'bin', 'prefilter.regex'), 'utf8'), prefilterSource() + '\n');
  });
  it('matches the guarded commands and passes plain ones (both sides)', () => {
    for (const c of ["kubectl exec p -- psql -c 'x'", 'git -C /r push origin', 'cd x && git commit -m a', 'npx jest --runTestsByPath x', 'docker compose up -d', 'PGPASSWORD=1 pg_dump db']) assert.ok(PRE_BASH_REGEX.test(c), c);
    for (const c of ['ls -la', 'echo hi && cat file', 'git status --porcelain', 'grep -n foo bar.ts', 'node --test']) assert.equal(PRE_BASH_REGEX.test(c), false, c);
  });
  it('lets every command resource-guard rates heavy reach the router — the shim must not cut them before Node', () => {
    const heavy = ['npm test', 'npm run test:unit', 'npm t', 'yarn test', 'yarn build', 'pnpm run build', 'bun test', './gradlew assembleRelease', 'gradle build', 'xcodebuild -scheme App', 'npx webpack', 'pod install', 'next build', 'vite build', 'emulator -avd Pixel', 'docker-compose up -d', 'docker buildx build .', 'npx jest x'];
    for (const c of heavy) {
      const [name, ...rest] = c.split(' ');
      assert.ok(heavyCommand(name, rest), `resource-guard must rate heavy: ${c}`);
      assert.ok(PRE_BASH_REGEX.test(c), `prefilter must pass: ${c}`);
    }
    for (const c of ['npm install', 'npm ci', 'yarn add left-pad', 'pod --version', 'next dev', 'docker ps']) {
      const [name, ...rest] = c.split(' ');
      assert.equal(heavyCommand(name, rest), null, `not heavy: ${c}`);
    }
  });
  it('reaches the router for literal writes the pre-write gates judge, and not for reads of the same paths', () => {
    for (const c of ["cat > ds.yaml <<'EOF'\ncommand: [sh, -c, \"ALTER ROLE app SET statement_timeout = '30s'\"]\nEOF", 'tee -a ~/.claude/projects/p/memory/x.md', "cat <<'EOF' > src/migrations/1786500000000-x.ts", "echo \"options: '-c statement_timeout=1'\" > ds.yaml", 'echo "SELECT set_config(1,2,false)" > q.sql']) assert.ok(PRE_BASH_REGEX.test(c), c);
    for (const c of ['ls ~/.claude/projects/p/memory/', 'grep -rn foo src/migrations/', 'cat notes.md', 'git log --oneline -- migrations/']) assert.equal(PRE_BASH_REGEX.test(c), false, c);
  });
});
