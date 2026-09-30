import { secretFileTrigger } from './secret-files.ts';

// Слова-триггеры pre-bash. Источник истины для bin/prefilter.regex (шим не умеет TS):
// test/meta/prefilter.test.ts requires byte equality. A false hit costs one Node start.
// A miss is silent: every form a gate judges must be proven to reach Node (owner-actions wiring test).
export const PRE_BASH_TRIGGERS: readonly string[] = [
  'psql', 'pgcli', 'pg_dump', 'pg_restore', 'PGPASSWORD', 'postgres(ql)?://',
  // git/glab by word, not by phrase: global options, quotes, tabs, line continuations and $G all sit between the
  // program and its verb, and the owner-actions gate must see every one of them (review 22.09)
  'git.*(commit|push|tag|update-ref)', 'glab', '/api/(v4/|graphql)',
  'jest', 'vitest', 'playwright', 'docker +(build|buildx|compose)', 'docker-compose', 'kind +(create|load)', 'run +build', 'tsc +-b',
  // resource-guard: package-runner scripts and build tools the gate rates heavy (resource.ts heavyCommand)
  '(npm|yarn|pnpm|bun)( +run(-script)?)? +(t|tst|test|build)', 'gradlew?|xcodebuild|webpack', 'pod +install', '(next|vite) +build', 'emulator +-avd',
  'corp-claude', 'codex +exec', 'kubectl +exec',
  // data-boundary: прод-канал, срез кластера и секрета, файлы учётных данных, ключи H20, окружение, дампы
  'mcp-pg-([a-z]+-)?prod', '(prod|dev)q\\.mjs', 'kubectl( +[^ |;&]+)* +(cp|secrets?)([ /,"]|$)',
  secretFileTrigger(), '(^|[^A-Za-z0-9_])\\.env([^A-Za-z0-9_-]|$)',
  '[Pp]assword|PASSWORD|[Tt]oken|TOKEN|[Aa]uthorization|AUTHORIZATION', 'printenv|(^|[ ;&|("])env *([;&|)"]|$)',
  'mysqldump|mongoexport|mongodump',
  // bash-writes: содержимое и пути, которые судят гейты записи, когда файл пишет сама команда (here-doc, echo, tee)
  'ALTER +(ROLE|DATABASE)', 'set_config', '(statement|lock|idle_in_transaction_session)_timeout|default_transaction_read_only',
  'options[^A-Za-z0-9_]{1,6}-c', '(>>?|tee)[^|;&]*(migrations?/|/memory/|MEMORY\\.md)',
  // owner-files: the owner's decisions under harness/owner/ are written only by the owner
  'harness/owner|pre-push-exceptions',
];
export const PRE_BASH_REGEX = new RegExp(PRE_BASH_TRIGGERS.join('|'));
export function prefilterSource(): string { return PRE_BASH_TRIGGERS.join('|'); }
