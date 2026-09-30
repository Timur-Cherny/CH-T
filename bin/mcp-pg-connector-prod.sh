#!/usr/bin/env bash
# stdio-обёртка MCP-сервера Postgres для PROD-контура коннектора (отдельная
# база коннектора). Инстанс задаётся отдельно: он может совпадать с инстансом
# движка, а может не совпадать — обёртка об этом не догадывается, адрес приходит
# из mcp-infra.sh.
#
# Зачем отдельный канал: реестр складов принадлежит коннектору — поле
# `warehouses.is_active` пишут админский тумблер и обработчик смены статуса
# мерчанта, и его же читает гейт создания заказа (WAREHOUSE_INACTIVE). В базе
# движка склада как сущности нет, поэтому вопрос «включён ли склад» из неё не
# отвечается вовсе, а из Django-реплики отвечается чужой стороной.
#
# Только чтение держит сам сервер (readonly-server.mjs): `BEGIN TRANSACTION
# READ ONLY` + именованный statement + пост-проверка режима, ROLLBACK всегда.
# Наличие всех трёх защит проверяется здесь ДО старта — см. lib/pg-prod-guard.sh.
# Правка прод-данных этим путём невозможна.
#
# Контур зашит литералами PG_CONNECTOR_PROD_*: увести обёртку в соседнюю базу из
# сессии нельзя — mcp-infra.sh читается ПОСЛЕ окружения и перекрывает его.
#
# Если адрес окажется репликой, а не мастером, добавить рядом с pg_guard_entry
# строку `pg_guard_standby "$TAG" "$ENTRY"` и экспорт флага обязательной реплики
# (имя флага — в mcp-pg-django-prod.sh; здесь литералом не писать: детектор в
# harness/test/mcp/pg-readonly-markers.test.ts ищет его подстрокой и засчитает
# комментарий за объявленный канал с реплики),
# как в mcp-pg-django-prod.sh: тогда подменённый адрес отказывает, а не читает
# мастер молча.
#
# Пароль берётся из ~/.pgpass библиотекой pg: аргументы процесса видны в `ps`.
set -euo pipefail

TAG=mcp-pg-connector-prod
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/pg-prod-guard.sh"

ENTRY="${MCP_PG_ENTRY:-$HOME/.claude/mcp/pg-server/readonly-server.mjs}"
pg_guard_entry "$TAG" "$ENTRY" || exit 1

# Режим проверки для тестов набора: маркеры сверены, дальше не идём.
[ -n "${MCP_PG_CHECK_ONLY:-}" ] && exit 0

pg_guard_infra "$TAG" PG_CONNECTOR_PROD_HOST PG_CONNECTOR_PROD_PORT PG_CONNECTOR_PROD_DB PG_CONNECTOR_PROD_USER || exit 1
pg_guard_pgpass "$TAG" || exit 1
pg_guard_net "$TAG" "$PG_CONNECTOR_PROD_HOST" "$PG_CONNECTOR_PROD_PORT" || exit 1

exec node "$ENTRY" "postgres://${PG_CONNECTOR_PROD_USER}@${PG_CONNECTOR_PROD_HOST}:${PG_CONNECTOR_PROD_PORT}/${PG_CONNECTOR_PROD_DB}"
