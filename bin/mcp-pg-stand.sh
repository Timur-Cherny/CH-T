#!/usr/bin/env bash
# stdio-обёртка MCP-сервера Postgres для ЛОКАЛЬНОГО стенда lms-local (k3s в colima, контекст colima).
#
# База стенда наружу не проброшена (colima отдаёт хосту только API k3s и шлюз), поэтому
# перед запуском сервера поднимаем port-forward и убеждаемся, что он живой. Порт
# нестандартный, чтобы не конфликтовать с локальным postgres, если такой появится.
#
# Прод НЕ обслуживается этой обёрткой сознательно (решение владельца): строка
# подключения жёстко указывает на базу стенда, сменить её на прод из сессии нельзя.
# Роль $PG_STAND_USER — только SELECT, проверено: CREATE TABLE отклоняется.
set -euo pipefail

INFRA="$HOME/.claude/env/mcp-infra.sh"
[ -r "$INFRA" ] || { echo "mcp-pg-stand: нет $INFRA — параметры контуров живут вне git, см. раздел «MCP-серверы» в README.md и bin/mcp-infra.sh.example" >&2; exit 1; }
. "$INFRA"
PORT="$PG_STAND_PORT"
CTX=colima
NS=lms-local
DB="$PG_STAND_DB"

# Пароль роли живёт в ~/.pgpass (строка 127.0.0.1:<порт>:<база>:<роль>) и в
# ~/.claude/.secrets/pg-stand-ro как источник истины при пересоздании стенда.
[ -r "$HOME/.pgpass" ] || { echo "mcp-pg-stand: нет ~/.pgpass — пароль взять негде" >&2; exit 1; }

# Порт уже слушает — значит мостик жив с прошлого запуска, ничего не делаем.
if ! nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
  nohup kubectl --context "$CTX" -n "$NS" port-forward svc/postgres "$PORT:5432" \
    >/tmp/mcp-pg-stand-portforward.log 2>&1 &
  for _ in $(seq 1 40); do
    nc -z 127.0.0.1 "$PORT" 2>/dev/null && break
    sleep 0.25
  done
  nc -z 127.0.0.1 "$PORT" 2>/dev/null || {
    echo "port-forward не поднялся; стенд запущен? см. /tmp/mcp-pg-stand-portforward.log" >&2
    exit 1
  }
fi

# Пинованная локальная копия вместо `npx -y`: версия сервера не должна меняться
# из сети на старте — read-only-обёртка живёт именно в его реализации.
# Пароль в строку подключения НЕ кладём: аргументы процесса видны в `ps`.
# Его берёт pg из ~/.pgpass по строке 127.0.0.1:<порт>:<база>:<роль>.
ENTRY="$HOME/.claude/mcp/pg-server/readonly-server.mjs"
[ -f "$ENTRY" ] || { echo "mcp-pg-stand: нет пинованного сервера ($ENTRY) — npm install в $HOME/.claude/mcp/pg-server" >&2; exit 1; }

exec node "$ENTRY" "postgres://${PG_STAND_USER}@127.0.0.1:${PORT}/${DB}"
