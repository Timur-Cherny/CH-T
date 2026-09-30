#!/usr/bin/env bash
# stdio-обёртка MCP-сервера Postgres для PROD-контура WMS (движок).
#
# Только чтение, и это свойство сервера, а не дисциплина вызывающего:
# readonly-server.mjs оборачивает каждый вызов в `BEGIN TRANSACTION READ ONLY`
# и всегда делает ROLLBACK. Транзакционный уровень пулер :5000 пропускает —
# в отличие от сессионного SET и стартового параметра: те за пулером достаются
# следующему клиенту и кладут запись на всём контуре.
#
# Правка прод-данных этим путём невозможна: только подготовленный скрипт,
# который выполняет человек.
#
# Контур зашит в обёртку литералами PG_PROD_*: сменить базу из сессии нельзя —
# источник адресов читается после окружения и перекрывает его. Соседний контур
# Django живёт в своей обёртке mcp-pg-django-prod.sh, общие проверки — в
# lib/pg-prod-guard.sh.
#
# Пароль берётся из ~/.pgpass библиотекой pg: аргументы процесса видны в `ps`.
set -euo pipefail

TAG=mcp-pg-prod
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/pg-prod-guard.sh"

ENTRY="${MCP_PG_ENTRY:-$HOME/.claude/mcp/pg-server/readonly-server.mjs}"
pg_guard_entry "$TAG" "$ENTRY" || exit 1

# Режим проверки для тестов набора: маркеры сверены, дальше не идём.
[ -n "${MCP_PG_CHECK_ONLY:-}" ] && exit 0

pg_guard_infra "$TAG" PG_PROD_HOST PG_PROD_PORT PG_PROD_DB PG_PROD_USER || exit 1
pg_guard_pgpass "$TAG" || exit 1
pg_guard_net "$TAG" "$PG_PROD_HOST" "$PG_PROD_PORT" || exit 1

exec node "$ENTRY" "postgres://${PG_PROD_USER}@${PG_PROD_HOST}:${PG_PROD_PORT}/${PG_PROD_DB}"
