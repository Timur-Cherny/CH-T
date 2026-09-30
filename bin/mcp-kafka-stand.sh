#!/usr/bin/env bash
# stdio-обёртка MCP-сервера Kafka для ЛОКАЛЬНОГО стенда lms-local (k3s в colima, контекст colima).
#
# Прод не обслуживается сознательно: кластер, namespace и bootstrap зашиты
# константами в mcp-kafka-stand.mjs, параметром вызова их не подменить.
# Поэтому запись сообщений здесь разрешена — она не может уехать дальше стенда.
#
# Аналог соседних обёрток pg-stand и youtrack: секретов не требует, доступ
# берётся из текущего kubeconfig.
set -euo pipefail

CTX=colima

command -v kubectl >/dev/null 2>&1 || { echo "mcp-kafka-stand: нет kubectl в PATH" >&2; exit 1; }

# Контекст проверяем до старта: иначе первая же команда упадёт внутри сессии
# невнятной ошибкой exec, и искать причину будут в сервере, а не в кластере.
if ! kubectl config get-contexts -o name 2>/dev/null | grep -qx "$CTX"; then
  echo "mcp-kafka-stand: в kubeconfig нет контекста $CTX — стенд не поднят?" >&2
  exit 1
fi

exec node "$HOME/.claude/bin/mcp-kafka-stand.mjs"
