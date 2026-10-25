# Пресет postgres-k8s

Площадка, где приложение живёт в Kubernetes, а данные — в Postgres: каналы к базам и шине по MCP только на чтение,
скиллы границы данных и производительности базы, фрагмент конфига дополнения `data-boundary`
(`harness/addons/data-boundary`). Ядро пресет не меняет: `pg-session` в ядре, `data-boundary` — дополнение харнесса,
включённое по умолчанию; пресет даёт им площадку.

## Состав

| Путь | Что |
|---|---|
| `bin/claude-mcp.sh` | сессия с нужными MCP-серверами: `claude-mcp.sh pg-stand kafka-stand` (`--list`, `-n` — показать конфиг) |
| `bin/mcp-pg-stand.sh` | Postgres локального стенда: port-forward из k8s, роль только с `SELECT` |
| `bin/mcp-pg-dev.sh` | Postgres dev-контура: каждый вызов в `BEGIN TRANSACTION READ ONLY` … `ROLLBACK` |
| `bin/mcp-pg-prod.sh` | прод; через `claude-mcp.sh` не подключается — только `mcp/pg-server/prodq.mjs` по явному запросу |
| `bin/lib/pg-prod-guard.sh` | одна копия проверок для всех прод-обёрток: read-only в сервере, адреса вне git, туннель |
| `bin/mcp-kafka-stand.*` | Kafka локального стенда через `kubectl exec`; запись только в стенд |
| `bin/mcp-youtrack.*` | YouTrack только на чтение (инструментов записи в сервере нет) |
| `mcp/pg-server/` | read-only сервер Postgres и клиенты `devq.mjs`/`prodq.mjs` |
| `skills/` | `data-boundaries`, `db-performance`, `local-stand-findings` |
| `harness.config.fragment.json` | `dataBoundary`: таблицы-конфигурация, точечный разбор, запрещённые колонки |

## Соглашение о прод-каналах

Гейт `data-boundary` узнаёт прод-обёртку по имени: `mcp-pg-prod` или `mcp-pg-<канал>-prod` (с `.sh` или без).
Второй прод-канал — копия `mcp-pg-prod.sh` с переменными `PG_<КАНАЛ>_PROD_*` и вызовом `pg_guard_*` из
`lib/pg-prod-guard.sh`; правки ядра не нужно.

## Установка

```sh
P="$PWD/presets/postgres-k8s"
ln -s "$P/bin" ~/.claude/bin && ln -s "$P/mcp" ~/.claude/mcp      # обёртки ищут себя под ~/.claude
(cd "$P/mcp/pg-server" && npm ci)                                 # SDK MCP и pg по lock-файлу
mkdir -p ~/.claude/env && cp "$P/bin/mcp-infra.sh.example" ~/.claude/env/mcp-infra.sh   # адреса — вне git
chmod 600 ~/.claude/env/mcp-infra.sh
# пароли — ~/.pgpass (chmod 600); токен YouTrack — ~/.claude/.secrets/youtrack-token (chmod 600)
for s in "$P"/skills/*/; do ln -s "$s" ~/.claude/skills/; done
# dataBoundary из harness.config.fragment.json — в ~/.claude/harness.config.json
"$P/bin/claude-mcp.sh" -n pg-stand                               # проверка: печатает конфиг, claude не запускает
```

Исполнителям Codex и Antigravity эти серверы недоступны, пока их имя не названо в `mcpAllowed` у `brain.config.json`
(их инструменты гейты не судят — только серверы на чтение).
