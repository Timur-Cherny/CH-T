#!/usr/bin/env bash
# stdio-обёртка MCP-сервера Postgres для DEV-контура WMS (движок).
#
# Только чтение, и это не дисциплина, а свойство сервера: server-postgres
# оборачивает каждый вызов в `BEGIN TRANSACTION READ ONLY` и всегда делает
# ROLLBACK (dist/index.js, обработчик CallTool). Транзакционный уровень пулер
# :5000 пропускает, в отличие от стартового параметра
# default_transaction_read_only — тот отбивается как unsupported startup parameter.
#
# Политика владельца по dev допускает запись, но канал сознательно сделан читающим:
# «писать можно, удалять нельзя» — это правило, которое некому проверить, а
# read-only транзакция проверяется сервером. Нужна запись на dev — отдельный
# инструмент с белым списком операций, не расширение этого.
#
# Пароль берётся из ~/.pgpass библиотекой pg (зависимость pgpass), в строке
# подключения его нет: аргументы процесса видны в `ps`.
set -euo pipefail

INFRA="$HOME/.claude/env/mcp-infra.sh"
[ -r "$INFRA" ] || { echo "mcp-pg-dev: нет $INFRA — адреса контуров живут вне git, см. раздел «MCP-серверы» в README.md и bin/mcp-infra.sh.example" >&2; exit 1; }
. "$INFRA"
HOST="$PG_DEV_HOST"
PORT="$PG_DEV_PORT"
DB="$PG_DEV_DB"
USER="$PG_DEV_USER"

[ -r "$HOME/.pgpass" ] || { echo "mcp-pg-dev: нет ~/.pgpass — пароль взять негде" >&2; exit 1; }

# Сеть проверяем до старта: без VPN сервер поднялся бы и падал на каждом
# запросе таймаутом, а причину искали бы в сервере, а не в туннеле.
if ! nc -z -G 3 "$HOST" "$PORT" 2>/dev/null; then
  echo "mcp-pg-dev: $HOST:$PORT недоступен — поднят ли OpenVPN (профиль контура)?" >&2
  exit 1
fi

# Пинованная локальная копия вместо `npx -y`: версия сервера не должна меняться
# из сети на старте — read-only-обёртка живёт именно в его реализации.
ENTRY="$HOME/.claude/mcp/pg-server/readonly-server.mjs"
[ -f "$ENTRY" ] || { echo "mcp-pg-dev: нет пинованного сервера ($ENTRY) — npm install в $HOME/.claude/mcp/pg-server" >&2; exit 1; }

exec node "$ENTRY" "postgres://${USER}@${HOST}:${PORT}/${DB}"
