#!/usr/bin/env bash
# stdio-обёртка MCP-сервера YouTrack — ТОЛЬКО ЧТЕНИЕ.
#
# Токен лежит отдельным файлом, а не в конфиге MCP и не в переменной окружения
# оболочки: конфиг попадает в бэкапы и в скриншоты, а окружение процесса видно
# в `ps -E`. Файл читается здесь и передаётся дочернему процессу напрямую.
# Тот же приём, что у соседней обёртки pg-stand.
#
# YouTrack read-only токенов не выдаёт — постоянный токен несёт все права
# учётки. Ограничение обеспечивает сам сервер: инструментов на запись в нём нет.
set -euo pipefail

INFRA="$HOME/.claude/env/mcp-infra.sh"
[ -r "$INFRA" ] || { echo "mcp-youtrack: нет $INFRA — адрес инстанса живёт вне git" >&2; exit 1; }
. "$INFRA"
URL="$YOUTRACK_URL"
TOKEN_FILE="$HOME/.claude/.secrets/youtrack-token"

if [ ! -r "$TOKEN_FILE" ]; then
  cat >&2 <<EOF
mcp-youtrack: нет файла с токеном: $TOKEN_FILE

Где взять: $URL → аватар справа вверху → Profile →
вкладка Account Security → Authentication → «New token…» → scope YouTrack.
Токен показывается один раз, начинается с perm-.

Положить так, чтобы файл не читался никем кроме владельца:
  mkdir -p "\$HOME/.claude/.secrets"
  printf '%s' 'perm-ВАШ_ТОКЕН' > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
EOF
  exit 1
fi

# Права проверяем явно: файл с токеном, доступный группе или всем, — это тот же
# секрет в открытом виде, только с ложным ощущением, что он спрятан.
PERMS=$(stat -f '%Lp' "$TOKEN_FILE" 2>/dev/null || stat -c '%a' "$TOKEN_FILE")
if [ "$PERMS" != "600" ] && [ "$PERMS" != "400" ]; then
  echo "mcp-youtrack: $TOKEN_FILE имеет права $PERMS — ожидались 600. chmod 600 и повторить." >&2
  exit 1
fi

YOUTRACK_URL="$URL" \
YOUTRACK_TOKEN="$(cat "$TOKEN_FILE")" \
  exec node "$HOME/.claude/bin/mcp-youtrack.mjs"
