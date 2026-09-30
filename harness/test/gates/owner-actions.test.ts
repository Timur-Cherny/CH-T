// INVARIANT: toward a company-git destination the agent never creates, moves, deletes or publishes a tag, never
// writes a protected branch directly and never merges an MR whose target is protected; what the gate cannot prove is
// denied. Listing tags, pushing existing feature/release/hotfix branches, deleting a proven branch, pushing to a
// non-company destination and merging into an unprotected branch pass. Every denied form is also proven to reach Node
// through the shim prefilter. A rule held by notes alone broke three times; the first, denylist version of this gate
// let 50+ forms through (review 22.09) — every one of them is a case below. Site values come from a config fixture.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, bashPayload, HARNESS_ROOT } from '../_env.ts';
import { decide, NAME } from '../../src/gates/owner-actions.ts';
import { route } from '../../src/main.ts';
import { resetConfigCache } from '../../src/config.ts';
import type { GateContext, HookPayload, Verdict } from '../../src/types.ts';

const sb = sandbox();
after(() => sb.cleanup());
const HOST = 'gitlab.corp.test';
const dir = (n: string): string => join(sb.dir, n);
const corp = dir('corp'); const corpm = dir('corpm'); const corpt = dir('corpt'); const own = dir('own');
const bin = dir('bin');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' };
const PREFILTER = readFileSync(join(HARNESS_ROOT, 'bin', 'prefilter.regex'), 'utf8').trim();

function g(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}
mkdirSync(join(sb.home, '.claude'), { recursive: true });
writeFileSync(join(sb.home, '.claude', 'harness.config.json'), JSON.stringify({ protectedBranches: ['product/main'], shellPaths: { file: '.claude/env/paths.sh', vars: ['APP_ENGINE'] } }));
resetConfigCache();
const ENV = (): NodeJS.ProcessEnv => ({ OWNER_GATE_HOSTS: HOST, PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: sb.home });
function payloadFor(command: string, cwd: string): HookPayload {
  const p = bashPayload(command) as unknown as HookPayload; (p as { cwd: string }).cwd = cwd; return p;
}
function run(command: string, cwd = corp): Verdict {
  const ctx: GateContext = { event: 'pre-bash', payload: payloadFor(command, cwd), env: ENV(), root: HARNESS_ROOT, stateDir: sb.stateDir, now: Date.now };
  return decide(ctx);
}
const reachesNode = (command: string, cwd: string): boolean =>
  spawnSync('grep', ['-qE', PREFILTER], { input: JSON.stringify(payloadFor(command, cwd)) }).status === 0;
function denied(cases: string[], cwd = corp): void {
  for (const c of cases) {
    assert.equal(run(c, cwd).kind, 'deny', `must deny: ${c}`);
    assert.ok(reachesNode(c, cwd), `shim prefilter must pass to Node: ${c}`);
  }
}
function silent(cases: string[], cwd = corp): void {
  for (const c of cases) { const v = run(c, cwd); assert.equal(v.kind, 'silent', `must pass: ${c}\n${(v as { reason?: string }).reason ?? ''}`); }
}

before(() => {
  const repo = (d: string, url: string): void => {
    g(sb.dir, 'init', '-q', d); g(d, 'remote', 'add', 'origin', url);
    writeFileSync(join(d, 'a.txt'), 'a\n'); g(d, 'add', '-A'); g(d, 'commit', '-q', '-m', 'base');
    g(d, 'branch', '-M', 'product/main'); g(d, 'tag', 'v1.0.0');
    for (const b of ['product/dev', 'feature/js-1', 'release/1.2.3', 'hotfix/js-2']) g(d, 'branch', b);
  };
  repo(corp, `https://${HOST}/product/app/backend/engine.git`);
  g(corp, 'checkout', '-q', 'feature/js-1');
  g(corp, 'config', 'branch.feature/js-1.remote', 'origin'); g(corp, 'config', 'branch.feature/js-1.merge', 'refs/heads/feature/js-1');
  g(corp, 'update-ref', 'refs/remotes/origin/feature/old', 'HEAD');
  repo(corpm, `https://${HOST}/product/app/backend/engine.git`);
  g(corpm, 'config', 'branch.product/main.remote', 'origin'); g(corpm, 'config', 'branch.product/main.merge', 'refs/heads/product/main');
  repo(corpt, `https://${HOST}/product/app/mobile/client-app.git`);
  g(corpt, 'remote', 'add', 'github', 'https://github.com/me/client-app.git');
  g(corpt, 'checkout', '-q', '-b', 'fix/x');
  g(corpt, 'config', 'branch.fix/x.remote', 'origin'); g(corpt, 'config', 'branch.fix/x.merge', 'refs/heads/fix/x');
  repo(own, 'https://github.com/me/brain.git');
  g(own, 'checkout', '-q', 'feature/js-1');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'glab'), [
    '#!/bin/sh',
    'case "$*" in',
    '  "mr view 12 -F json"|"mr view 13 -F json"|"mr view 21 -F json") echo \'{"target_branch":"product/main"}\' ;;',
    '  "mr view 14 -F json"|"mr view -F json") echo \'{"target_branch":"product/dev"}\' ;;',
    '  "mr view 15 -F json -R product/app/frontend/web-client") echo \'{"target_branch":"product/main"}\' ;;',
    '  "api projects/:id/merge_requests/12") echo \'{"target_branch":"product/main"}\' ;;',
    '  "api projects/:id/merge_requests/14") echo \'{"target_branch":"product/dev"}\' ;;',
    '  *) exit 1 ;;',
    'esac',
  ].join('\n') + '\n');
  chmodSync(join(bin, 'glab'), 0o755);
  mkdirSync(join(sb.home, '.claude', 'env'), { recursive: true });
  writeFileSync(join(sb.home, '.claude', 'env', 'paths.sh'), `export APP_ENGINE="${corpm}"\n`);
  g(corpm, 'branch', '-f', 'feature/js-9');
});

describe('owner-actions: tags', () => {
  it('denies creating, annotating, forcing and deleting a tag in any spelling that reaches git', () => {
    denied(['git tag v1.2.3', 'git tag -a v1.2.3 -m release', 'git tag -am release v1.2.3', 'git tag -d v1.0.0', 'git tag -f v1.0.0', 'git tag --delete v1.0.0',
      'git tag --sort=-creatordate v9.9.1', 'git tag --format=x v9.9.2', 'git tag -i v9.9.3', 'git tag --column v9.9.4', 'git tag --no-column v9.9.5',
      'git --no-pager tag v1.2.3', 'git -P tag v1.2.3', 'git -c core.pager=cat tag v1.2.3', 'git\ttag v1.2.3', 'git \\\ntag v1.2.3', '"git" tag v1.2.3', 'git "tag" v1.2.3',
      'G=git; $G tag v1.2.3', 'sh -c "git tag v1.2.3"', 'eval git tag v1.2.3', 'echo v1.2.3 | xargs git tag', 'git -c alias.t=tag t v8.8.8', 'git update-ref refs/tags/v7.7.7 HEAD',
      `git -C ${corp} tag v2.0.0`, `cd ${corp} && git tag v2.0.0`]);
  });
  it('denies a tag written through a redirected or unresolved repository instead of guessing it is not a company one', () => {
    denied([`GIT_DIR=${corp}/.git git tag v1.2.3`, `git --git-dir=${corp}/.git tag v1.2.3`, 'cd $OWNER_GATE_NOPE && git tag v3.0.0'], own);
  });
  it('lets listing and inspection through — list mode comes only from the switches git reads as list', () => {
    silent(['git tag', "git tag -l 'v1.*'", 'git tag --list', 'git tag --contains HEAD', 'git tag --points-at HEAD', 'git tag -n5', 'git tag --sort=-creatordate',
      "git tag -l 'v1.*' --sort=-v:refname | head -1", 'git tag --merged product/main', 'git tag -n5 --contains HEAD', 'git tag -v v1.0.0']);
  });
  it('does not judge a repository whose remotes are not the company GitLab', () => {
    silent(['git tag v9', 'git push origin --tags'], own);
  });
});

describe('owner-actions: push', () => {
  it('denies publishing or deleting a tag by any refspec form', () => {
    denied(['git push origin --tags', 'git push --follow-tags origin', 'git push --mirror origin', 'git push origin refs/tags/v1.0.0', 'git push origin :refs/tags/v1.0.0',
      'git push origin v1.0.0', 'git push origin tags/v1.0.0', 'git push origin v1.0.0:v1.0.0', 'git push --delete origin v1.9.9', 'git push origin :v1.9.89-rc1',
      'git push origin tag v1.0.0', 'git update-ref refs/tags/v7.7.7 HEAD && git push origin v7.7.7']);
  });
  it('denies writing product/main from any branch, by DWIM names, globs and deletion', () => {
    denied(['git push origin release/1.2.3:product/main', 'git push origin HEAD:product/main', 'git push origin HEAD:heads/product/main', 'git push origin heads/product/main',
      'git push origin +feature/js-1:refs/heads/product/main', "git push origin 'refs/*:refs/*'", "git push origin 'refs/heads/*:refs/heads/*'", 'git push origin :product/main',
      'git push --delete origin product/main', 'git push origin --branches', 'git --no-pager push origin HEAD:product/main', 'git\tpush origin HEAD:product/main',
      "git 'push' origin HEAD:product/main", "bash -c 'git push origin HEAD:product/main'", 'echo HEAD:product/main | xargs git push origin',
      'git push origin $(git rev-parse --abbrev-ref HEAD):$(cat target)']);
  });
  it('denies a push whose meaning is changed by config or state set earlier in the same command', () => {
    denied(['git -c push.followTags=true push origin feature/js-1', 'git -c remote.origin.push=HEAD:refs/heads/product/main push origin',
      'git config remote.origin.push HEAD:refs/heads/product/main && git push origin', 'git checkout product/main && git push origin HEAD',
      'git switch product/main && git merge feature/js-1 && git push origin @']);
  });
  it('denies an auto-merge push option toward main or toward an unnamed target, and lets a plain MR-creating push through', () => {
    denied(['git push -o merge_request.create -o merge_request.target=product/main -o merge_request.merge_when_pipeline_succeeds origin feature/js-1',
      'git push --push-option=merge_request.merge_when_pipeline_succeeds origin feature/js-1']);
    silent(['git push -o merge_request.create -o merge_request.target=product/main origin release/1.2.3']);
  });
  it('denies a bare or HEAD push while product/main is checked out', () => {
    denied(['git push', 'git push origin', 'git push origin HEAD', 'git push origin @'], corpm);
  });
  it('judges by the destination: a company URL from any repository is judged, a non-company remote from a company repository is not', () => {
    denied([`git push https://${HOST}/x/y.git HEAD:product/main`, `git push https://${HOST}/x/y.git --tags`, `git remote add s https://${HOST}/x.git && git push s HEAD:product/main`,
      'cd ../corp && git push origin HEAD:product/main', 'cd "$(git rev-parse --show-toplevel)/../corp" && git push origin HEAD:product/main'], own);
    silent(['git push github --tags', `git push --mirror ${dir('backup.git')}`, 'git push', 'git push -u origin HEAD', 'git push origin fix/x'], corpt);
  });
  it('lets existing feature, release, hotfix and dev branches, dry runs and proven branch deletions through', () => {
    silent(['git push origin feature/js-1', 'git push -u origin release/1.2.3', 'git push origin hotfix/js-2', 'git push origin product/dev', 'git push --force-with-lease origin feature/js-1',
      'git push origin HEAD', 'git push', 'git push origin product/main:backup/product-main-20260922', 'git push origin :refs/heads/feature/old', 'git push --delete origin feature/old',
      'git push --tags --dry-run origin', 'git push -n origin HEAD:product/main']);
  });
  it('resolves the configured path variables from the file the owner shell sources, which the hook environment lacks', () => {
    denied(['cd $APP_ENGINE && git push', 'git -C $APP_ENGINE push origin v1.0.0', 'cd $APP_ENGINE && git push origin :v1.0.0']);
    silent(['cd $APP_ENGINE && git tag -l', 'cd $APP_ENGINE && git push -u origin feature/js-9']);
  });
  it('does not mistake text that mentions the commands for the commands', () => {
    silent(["cat > notes.md <<'EOF'\ngit tag v1.2.3\ngit push origin HEAD:product/main\nEOF", 'echo "git tag v1.2.3"', 'grep -rn "git push origin" docs',
      "git commit -m \"$(cat <<'EOF'\ndocs: git push origin HEAD:product/main\nEOF\n)\""]);
  });
});

describe('owner-actions: glab and the GitLab API', () => {
  it('denies merging an MR whose target GitLab reports as product/main, by any spelling', () => {
    denied(['glab mr merge 12', 'glab mr merge 13 --squash -y', 'glab mr accept 12', 'glab mr -R product/app/frontend/web-client merge 15', 'glab -R product/app/frontend/web-client mr merge 15',
      'glab api -X PUT projects/:id/merge_requests/12/merge', 'glab api --method=PUT projects/:id/merge_requests/12/merge', 'glab api -X PUT "projects/:id/merge_requests/12/merge?auto_merge=true"',
      'glab api --output json -X PUT projects/:id/merge_requests/12/merge', 'glab api --form squash=true -X PUT projects/:id/merge_requests/12/merge']);
  });
  it('denies aliases, graphql mutations, retargeting to main and merging after a retarget in the same command', () => {
    denied(['glab mm 12', 'glab alias set mm "mr merge" && glab mm 12', 'glab api graphql -f query="mutation { mergeRequestAccept(input: {iid: 12}) { errors } }"',
      'glab mr update 14 --target-branch product/main', 'glab mr update 14 --target-branch product/main && glab mr merge 14']);
  });
  it('denies releases and API writes to tags, commits and protection, including through curl', () => {
    denied(['glab release create v1.9.10 --ref product/main', 'glab release delete v1.9.9 --with-tag -y', 'glab api -X POST projects/:id/repository/tags -f tag_name=v1.9.10 -f ref=product/main',
      'glab api -X DELETE projects/:id/repository/tags/v1.9.9', 'glab api -X POST projects/:id/repository/commits -F branch=product/main -F commit_message=x',
      `curl -sS -X PUT -H "PRIVATE-TOKEN: x" https://${HOST}/api/v4/projects/1/merge_requests/12/merge`, `curl -X POST https://${HOST}/api/v4/projects/1/repository/tags -d tag_name=v2`]);
  });
  it('denies a merge whose target GitLab does not confirm, or whose directory is unknown', () => {
    denied(['glab mr merge 99', 'cd $OWNER_GATE_NOPE && glab mr merge 21']);
    assert.match((run('glab mr merge 99') as { reason: string }).reason, /цель мержа не установлена/);
  });
  it('lets a merge into product/dev, reads, MR creation, notes and release listing through', () => {
    silent(['glab mr merge 14', 'glab mr merge 14 -m "merge" -y --squash', 'glab mr merge', 'glab mr view 12', 'glab api projects/:id/merge_requests/12',
      'glab api "projects/:id/merge_requests?target_branch=product/main&state=merged"', 'glab mr create --target-branch product/main --source-branch release/1.2.3 --title x -y',
      'glab api projects/:id/merge_requests/12/merge', 'glab api --method GET projects/:id/merge_requests/12/merge', 'glab api -X PUT projects/:id/merge_requests/14/merge',
      'glab release list', 'glab release view v1.0.0', 'glab ci status', 'glab mr note 14 -m "@ai-code-reviewer"', `curl -s https://${HOST}/api/v4/projects/1/merge_requests/12`]);
  });
});

// Review 22.09: HTTP clients and GraphQL merged or wrote to GitLab past the gate, and
// `glab mr merge --help` was refused as a merge with an unconfirmed target.
describe('owner-actions: HTTP clients, GraphQL and help', () => {
  const api = `https://${HOST}/api/v4/projects/726`;
  it('judges an upload, a positional method word and httpie data items as writes', () => {
    denied([`curl -sS -T /dev/null ${api}/merge_requests/12/merge`, `curl --upload-file x ${api}/merge_requests/12/merge`,
      `http PUT ${api}/merge_requests/12/merge`, `xh put ${api}/merge_requests/12/merge`, `https PUT ${api}/merge_requests/12/merge`,
      `http ${api}/repository/tags tag_name=v2 ref=product/main`, `wget --method=PUT ${api}/merge_requests/12/merge`, `wget --post-data=x ${api}/repository/tags`]);
  });
  it('judges GraphQL as a write unless its body is a literal without a mutation', () => {
    denied([`curl -sS https://${HOST}/api/graphql --json '{"query":"mutation{mergeRequestAccept(input:{iid:\\"12\\"}){errors}}"}'`,
      `curl -sS https://${HOST}/api/graphql -d @q.json`, `curl -sS https://${HOST}/api/graphql --data-binary @-`,
      'glab api graphql --input q.json', 'glab api graphql -f query=@q.graphql', 'glab api graphql -F query=@q.graphql']);
    silent([`curl -s https://${HOST}/api/graphql --json '{"query":"query{currentUser{username}}"}'`,
      "glab api graphql -f query='query { currentUser { username } }'"]);
  });
  it('lets reads and help through', () => {
    silent(['glab mr merge --help', 'glab mr merge -h', 'glab api --help', 'glab release create --help', 'git push --help', 'git tag -h',
      `http GET ${api}/merge_requests/12`, `curl -s ${api}/merge_requests/12`, `xh ${api}/merge_requests/12`]);
  });
});

describe('owner-actions: wiring', () => {
  const env = (): Record<string, string> => ({ HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, OWNER_GATE_HOSTS: HOST, PATH: `${bin}:${process.env.PATH ?? ''}` });
  it('is denied through route() with the gate name', async () => {
    const v = await route('pre-bash', payloadFor('git tag v5.0.0', corp), env());
    assert.equal(v.kind, 'deny'); assert.match((v as { reason: string }).reason, new RegExp(NAME));
  });
  it('is silent under CLAUDE_SKIP_OWNER_GATE=1 read from the process environment', async () => {
    assert.equal((await route('pre-bash', payloadFor('git tag v5.0.0', corp), { ...env(), CLAUDE_SKIP_OWNER_GATE: '1' })).kind, 'silent');
  });
  it('does not read the kill-switch from the command itself', () => {
    denied(['CLAUDE_SKIP_OWNER_GATE=1 git tag v6.0.0']);
  });
});
