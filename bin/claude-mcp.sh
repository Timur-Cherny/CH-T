#!/usr/bin/env bash
# Сессия Claude Code с MCP-серверами ПО ЗАПРОСУ.
#
# Реестр ~/.claude.json серверов не держит: всё, что там зарегистрировано, Claude Code поднимает
# на каждом старте и кладёт инструкции сервера в системный промпт (отложены только схемы
# инструментов — tool search; инструкции отложить нельзя).
# Здесь сервер подключается на ту сессию, где он нужен, — и только он:
#
#   claude-mcp.sh pg-stand kafka-stand              сессия с двумя серверами
#   claude-mcp.sh pg-stand -- -p 'сколько заказов'  после -- идут аргументы самого claude
#   claude-mcp.sh --list                            имена, известные по bin/mcp-<имя>.sh
#   claude-mcp.sh -n pg-stand                       напечатать конфиг и аргументы, claude не запускать
#
# Прод-обёртки (mcp-pg-*prod.sh) не подключаются: прод зовётся клиентом mcp/pg-server/prodq.mjs
# по явному запросу (решение 25.07), и этот запуск его не обходит.
set -euo pipefail

case "${BASH_SOURCE[0]}" in */*) BIN="${BASH_SOURCE[0]%/*}" ;; *) BIN=. ;; esac
BIN="$(cd "$BIN" && pwd -P)"
USAGE='claude-mcp.sh <имя>... [-- <аргументы claude>] | --list | -n <имя>...'

names=()
dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    -n) dry=1 ;;
    -h|--help) echo "$USAGE"; exit 0 ;;
    --list)
      for f in "$BIN"/mcp-*.sh; do
        n="${f##*/mcp-}"; n="${n%.sh}"
        case "$n" in pg-*prod) ;; *) echo "$n" ;; esac
      done
      exit 0 ;;
    -*) echo "claude-mcp: неизвестный флаг '$1' — аргументы claude идут после --" >&2; exit 2 ;;
    *) names+=("$1") ;;
  esac
  shift
done
[ "${#names[@]}" -gt 0 ] || { echo "$USAGE" >&2; exit 2; }

servers=""
seen=" "
for n in "${names[@]}"; do
  case "$n" in
    *[!a-z0-9-]*) echo "claude-mcp: имя '$n' — допустимы только [a-z0-9-]" >&2; exit 2 ;;
    pg-*prod) echo "claude-mcp: '$n' — прод как MCP не подключается; клиент mcp/pg-server/prodq.mjs по запросу" >&2; exit 2 ;;
  esac
  case "$seen" in *" $n "*) continue ;; esac
  seen="$seen$n "
  w="$BIN/mcp-$n.sh"
  [ -x "$w" ] || { echo "claude-mcp: нет обёртки $w (имена: --list)" >&2; exit 2; }
  e="${w//\\/\\\\}"; e="${e//\"/\\\"}"
  servers="${servers:+$servers,}\"$n\":{\"type\":\"stdio\",\"command\":\"$e\"}"
done
config="{\"mcpServers\":{$servers}}"

if [ "$dry" = 1 ]; then
  printf '%s\n' "$config"
  [ $# -gt 0 ] && printf '%q ' "$@"
  printf '\n'
  exit 0
fi
exec claude --mcp-config "$config" "$@"
