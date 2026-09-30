#!/usr/bin/env bash
# stdio-обёртка MCP-сервера Postgres для PROD-контура Django (`main_backend`,
# база `market`). Инстанс СВОЙ — не тот, где живёт движок WMS.
#
# Ходим на РЕПЛИКУ, а не на мастер: нагрузка чтения не ложится на инстанс, с
# которого работает монолит. «Реплика» здесь не договорённость, а проверка —
# PG_RO_REQUIRE_STANDBY=1 заставляет сервер отбивать запрос на инстансе, где
# pg_is_in_recovery() = false. Подменённый адрес поэтому отказывает, а не молча
# читает мастер. Цена реплики — отставание: свежая запись может ещё не доехать.
#
# Зачем отдельный канал: заказы (`LT-`) и поставки (`SUPPLY-`) рождаются здесь,
# а в WMS приезжают по Kafka — расхождение «в WMS заказа нет» читается только с
# обеих сторон сразу. Раньше эта сторона бралась из чужих рук или не бралась
# вовсе.
#
# Только чтение держит сам сервер (readonly-server.mjs): `BEGIN TRANSACTION
# READ ONLY` + именованный statement + пост-проверка режима, ROLLBACK всегда.
# Наличие всех трёх защит проверяется здесь ДО старта — см. lib/pg-prod-guard.sh.
# Правка прод-данных этим путём невозможна.
#
# Контур зашит литералами PG_DJANGO_PROD_*: увести обёртку в соседнюю базу из
# сессии нельзя — mcp-infra.sh читается после окружения и перекрывает его.
#
# Пароль берётся из ~/.pgpass библиотекой pg: аргументы процесса видны в `ps`.
set -euo pipefail

TAG=mcp-pg-django-prod
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/pg-prod-guard.sh"

ENTRY="${MCP_PG_ENTRY:-$HOME/.claude/mcp/pg-server/readonly-server.mjs}"
pg_guard_entry "$TAG" "$ENTRY" || exit 1
pg_guard_standby "$TAG" "$ENTRY" || exit 1

# Режим проверки для тестов набора: маркеры сверены, дальше не идём.
[ -n "${MCP_PG_CHECK_ONLY:-}" ] && exit 0

pg_guard_infra "$TAG" PG_DJANGO_PROD_HOST PG_DJANGO_PROD_PORT PG_DJANGO_PROD_DB PG_DJANGO_PROD_USER || exit 1
pg_guard_pgpass "$TAG" || exit 1
pg_guard_net "$TAG" "$PG_DJANGO_PROD_HOST" "$PG_DJANGO_PROD_PORT" || exit 1

# Читаем со standby, и это проверяет сервер на каждом вызове, а не комментарий здесь.
export PG_RO_REQUIRE_STANDBY=1

exec node "$ENTRY" "postgres://${PG_DJANGO_PROD_USER}@${PG_DJANGO_PROD_HOST}:${PG_DJANGO_PROD_PORT}/${PG_DJANGO_PROD_DB}"
