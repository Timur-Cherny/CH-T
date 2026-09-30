# Claude Code Harness

Детерминированный слой проверок для Claude Code: TypeScript под Node 24, без сборки и без `node_modules`.

## Зачем

Планка качества держится машинерией и не зависит от того, какая модель подключена: сильная проходит её
быстрее, слабая — дольше и дороже, но не хуже. Проверка любого элемента контура: *если качество зависит от
того, насколько умна модель, элемент спроектирован неверно.*

Отсюда четыре свойства:

- **проверка висит на состоянии рабочего дерева, а не на событии инструмента** — правка любой дверью
  (`Write`, `sed`, heredoc, `python -c`, `git apply`, MCP, субагент) видна одинаково;
- **вердикт выносят парсеры, а не regex** — SQL разбирает libpg_query, TypeScript — compiler API проекта,
  команду оболочки — собственный парсер по грамматике POSIX (§2.3 лексер, §2.10 рекурсивный спуск) с
  расширениями bash;
- **отсутствие данных — это `unknown`, а не тишина и не `pass`**; на pre-событиях `unknown` становится `ask`
  там, где человек видит вопрос (`default`, `acceptEdits`, `plan`), и `deny` там, где вопрос никто не увидит
  (`auto`, `bypassPermissions`, `dontAsk`) — `harness/src/emit.ts`;
- **один язык, один процесс на событие, один контракт выхода**.

Устройство контура — [`harness/README.md`](harness/README.md). Конвенции для тех, кто пишет новый гейт, —
[`harness/PORTING.md`](harness/PORTING.md).

## Установка (macOS и Linux)

```sh
git clone <этот-репозиторий> ~/src/claude-harness
cd ~/src/claude-harness

# 1. Node 24 и TypeScript для контура, симлинк ~/.claude/harness, прогрев compile cache.
#    Нет Node >= 24 — --ensure-node скачает официальную сборку в ~/.claude/env/node со сверкой SHASUMS256;
#    PATH, nvm и Node других проектов не трогаются. TypeScript для проверок содержимого install.sh ставит сам —
#    ровно та версия, что в harness/TOOLCHAIN.lock (integrity + sha256).
harness/install.sh --ensure-node

# 2. Подключить события. Если своего ~/.claude/settings.json ещё нет:
ln -s "$PWD/settings.json" ~/.claude/settings.json
#    Если есть — перенеси в него блок "hooks" из settings.json этого репозитория целиком.

# 3. Необязательно: конфиг площадки (защищённые ветки, хосты компании, переменные путей, таблицы-конфигурация).
cp harness/harness.config.example.json ~/.claude/harness.config.json
```

Проверить, что встало, — привязанные события, живой ответ барьера (явная модель у субагента запрещена, ждём
rc 2 от `model-gate`) и сьют:

```sh
grep -o 'harness/bin/hook [a-z-]*' ~/.claude/settings.json | sort -u
printf '{"session_id":"check","cwd":"%s","hook_event_name":"PreToolUse","permission_mode":"default","tool_name":"Agent","tool_input":{"model":"haiku"}}' "$PWD" \
  | ~/.claude/harness/bin/hook pre-agent; echo "rc=$?"
cd harness && ~/.claude/harness/bin/run --test 'test/**/*.test.ts'
```

Без TypeScript проверки содержимого честно отвечают `unknown`, а не `pass`, и сьют это показывает.

## Конфиг площадки

Всё, что принадлежит одной машине и одной организации, живёт в конфиге, а не в коде. Действует первый найденный:
`CLAUDE_HARNESS_CONFIG` → `~/.claude/harness.config.json` → `harness.config.json` в корне чекаута, рядом с
`harness/` (его находит шим, так что сессия в самом репозитории видит свою площадку без симлинка). Какой конфиг
в силе, печатает `install.sh`. Образец со всеми полями — `harness/harness.config.example.json`, контракт —
`harness/src/config.ts`.

| Поле | Без конфига |
|---|---|
| `protectedBranches` | `main` — прямой push и MR только с `release/*` либо `hotfix/*` |
| `ownerHosts` | ни один хост не считается git компании — `owner-actions` судит только `glab` и явные API-вызовы |
| `shellPaths`, `freshness` | `git-freshness` ничего не смотрит |
| `dataBoundary.configTables` | ни одна таблица прода не считается конфигурацией — строки прода только бизнес-данные |
| `workDocs` | напоминание о work-doc молчит |

Файла нет — это обычная новая машина. Файл есть, но не читается (битый JSON, поле не той формы) — это
`problem`: `pre-push-guard` отвечает `unknown`, `owner-actions` — `deny` на push, теги, `glab` и API, пока
конфиг не починен. Защищать дефолты вместо настоящих веток — отказ в открытую сторону, его здесь нет.

## MCP-серверы

Серверы подключаются на ту сессию, где они нужны, а не на каждый старт: `bin/claude-mcp.sh <имя>...` собирает
`--mcp-config` из найденных обёрток `bin/mcp-<имя>.sh` (`--list` — имена, `-n` — показать конфиг, не запуская).

| Имя | Что | Доступ |
|---|---|---|
| `pg-stand` | Postgres локального стенда (port-forward из k8s) | только чтение: `readonly-server.mjs` + роль с одним `SELECT` |
| `pg-dev` | Postgres dev-контура | только чтение: каждый вызов в `BEGIN TRANSACTION READ ONLY` … `ROLLBACK` |
| `pg-prod`, `pg-django-prod`, `pg-connector-prod` | прод | через `claude-mcp.sh` не подключаются; `mcp/pg-server/prodq.mjs` по явному запросу, охрана — `bin/lib/pg-prod-guard.sh` |
| `kafka-stand` | Kafka локального стенда | чтение и запись; кластер зашит в `mcp-kafka-stand.mjs`, дальше стенда не уйдёт |
| `youtrack` | YouTrack | только чтение: инструментов записи в сервере нет |

```sh
ln -s "$PWD/bin" ~/.claude/bin && ln -s "$PWD/mcp" ~/.claude/mcp   # обёртки ищут себя под ~/.claude
(cd mcp/pg-server && npm ci)                                       # SDK MCP и pg по lock-файлу
cp bin/mcp-infra.sh.example ~/.claude/env/mcp-infra.sh             # адреса контуров; вне git
# пароли — ~/.pgpass (chmod 600); токен YouTrack — ~/.claude/.secrets/youtrack-token (chmod 600)
bin/claude-mcp.sh -n pg-stand                                      # проверка: печатает конфиг, claude не запускает
```

## Что внутри

| Путь | Роль |
|---|---|
| `harness/bin/hook` | единственный вход из `settings.json`: пин Node, `NODE_COMPILE_CACHE`, префильтр `pre-bash` без запуска Node |
| `harness/bin/run` | запуск скриптов контура под его Node 24 |
| `harness/src/gates/` | гейты по событиям; реестр `registry.ts`, порядок — `index.ts` |
| `harness/src/checks/` | ярусные проверки изменённого файла (syntax, project-check, tsc, комментарии, tripwire, contour-suite) |
| `harness/src/parsers/` | лексер и парсер оболочки по грамматике, libpg_query для SQL, compiler API для TypeScript |
| `harness/src/state.ts` | `node:sqlite` (WAL): подтверждения, находки, окна агентов, задания |
| `harness/scripts/` | расписание прогонов, прогон команд из транскриптов через оба разборщика, тулчейн, метрики |
| `settings.json` · `.claude/settings.json` | привязка событий: user-level и repo-level |
| `agents/` · `skills/` | субагенты и сквозные скиллы дисциплины доказательства |
| `bin/` · `mcp/pg-server/` | MCP по запросу: запускатель `claude-mcp.sh`, обёртки `mcp-*.sh`, read-only сервер Postgres |

Состав гейтов не поддерживается руками — он печатается из реестра:

```sh
cd harness && ~/.claude/harness/bin/run -e '
  await import("./src/gates/index.ts");
  const { GATES } = await import("./src/gates/registry.ts");
  for (const g of GATES) console.log(g.name.padEnd(24), g.killSwitch.padEnd(30), g.events.join(","));'
```

У каждого гейта свой выключатель `CLAUDE_SKIP_*=1` из окружения процесса Claude Code, не из команды агента;
общего выключателя нет намеренно.

## Границы

- Контур проверяет то, что видит в рабочем дереве и в аргументах команд. Доступ в обход этого (например,
  чтение базы через `kubectl exec`) `pg-session` по построению не отбивает: он держит состояние соединения,
  границу данных держит `data-boundary`.
- Старый токенизатор ещё доступен под `CLAUDE_HARNESS_SHELL_PARSER=legacy` — для прогона транскриптов обоими
  разборщиками (`harness/scripts/shell-replay.ts`); удаляется после прогона без переходов `deny→clean`.
- `data-boundary` знает прод-обёртки `mcp-pg-*-prod` по имени: это соглашение автора, вынести его в конфиг — долг.
- Воспроизведённые и ещё не исправленные дефекты сверки перечислены в `harness/README.md`, раздел «Известные
  дефекты».
- Причины отказов написаны по-русски.
