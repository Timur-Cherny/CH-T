import { nextFreeMigrationStamp } from '../src/gates/migration-name.ts';
import { isMainModule } from '../src/is-main.ts';

function value(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

export function main(args = process.argv.slice(2)): number {
  const repo = value(args, '--repo');
  const dir = value(args, '--dir');

  if (!repo || !dir) {
    console.error('usage: next-migration-stamp.ts --repo <repo> --dir <migrations-dir>');
    return 64;
  }

  const r = nextFreeMigrationStamp(repo, dir, process.env);
  if (!r.ok) {
    console.error(r.reason);
    return 1;
  }

  console.log(r.stamp);
  return 0;
}

if (isMainModule(import.meta.url)) process.exit(main());
