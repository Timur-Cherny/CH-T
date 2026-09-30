# Резолв бинаря Node >= 24: одно определение для bin/hook и bin/run.
# Порядок: $CLAUDE_HARNESS_NODE → ~/.claude/env/harness.env → старший v24+ из ~/.nvm/versions/node и ~/.claude/env/node
# (по ЧИСЛЕННОМУ сравнению: лексикографически v24.9 > v24.20) → node >= 24 в PATH.
# После вызова: node_bin — путь к бинарю или пустая строка (рантайма нет).
#
# harness.env читается и тогда, когда Node уже пинован окружением: в том же файле лежит пин
# CLAUDE_HARNESS_TS, и он не экспортировался НИКОГДА — структурные проверки (comment-bloat, язык
# комментариев, tripwire) отвечали unknown в каждой живой сессии, а выглядело это как норма.
# Пин из окружения остаётся главнее файла: тесты подставляют свой node именно так.
harness_pin_node() {
  node_bin=""
  env_node="${CLAUDE_HARNESS_NODE:-}"
  env_ts="${CLAUDE_HARNESS_TS:-}"
  if [ -f "$HOME/.claude/env/harness.env" ] && { [ -z "$env_node" ] || [ -z "$env_ts" ]; }; then
    # shellcheck disable=SC1090
    . "$HOME/.claude/env/harness.env"
    [ -n "$env_node" ] && CLAUDE_HARNESS_NODE="$env_node"
    [ -n "$env_ts" ] && CLAUDE_HARNESS_TS="$env_ts"
  fi
  [ -n "${CLAUDE_HARNESS_TS:-}" ] && export CLAUDE_HARNESS_TS

  if [ -n "${CLAUDE_HARNESS_NODE:-}" ] && [ -x "${CLAUDE_HARNESS_NODE}" ]; then
    node_bin="$CLAUDE_HARNESS_NODE"
  fi
  if [ -z "$node_bin" ]; then
    best=0
    for cand in "$HOME"/.nvm/versions/node/v*/bin/node "$HOME"/.claude/env/node/v*/bin/node; do
      [ -x "$cand" ] || continue
      ver="${cand##*/node/v}"; ver="${ver%%/*}"
      maj="${ver%%.*}"; rest="${ver#*.}"; min="${rest%%.*}"; pat="${rest#*.}"
      case "$maj$min$pat" in *[!0-9]*) continue ;; esac
      [ "$maj" -ge 24 ] || continue
      key=$(( maj * 1000000 + min * 1000 + pat ))
      if [ "$key" -gt "$best" ]; then best=$key; node_bin="$cand"; fi
    done
  fi
  if [ -z "$node_bin" ] && command -v node >/dev/null 2>&1; then
    pmaj="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
    case "$pmaj" in *[!0-9]*|'') ;; *) [ "$pmaj" -ge 24 ] && node_bin="$(command -v node)" ;; esac
  fi
  return 0
}

# Site config of the checkout: when neither CLAUDE_HARNESS_CONFIG nor ~/.claude/harness.config.json is there (not even
# a dangling link), harness.config.json next to the harness root is the one in force — a checkout carries its own site,
# and a repo-level session finds it without a manual symlink. REGRESSION 25.09: the site moved out of code into config,
# nothing installed the file, and the owner's protection was silently off. Caller sets `root` (the physical harness).
harness_pin_config() {
  [ -n "${CLAUDE_HARNESS_CONFIG:-}" ] && return 0
  home_cfg="${HOME:-}/.claude/harness.config.json"
  { [ -e "$home_cfg" ] || [ -L "$home_cfg" ]; } && return 0
  [ -f "$root/../harness.config.json" ] && CLAUDE_HARNESS_CONFIG="$(cd "$root/.." && pwd -P)/harness.config.json" && export CLAUDE_HARNESS_CONFIG
  return 0
}

# Тулчейн TypeScript на месте: файл пина CLAUDE_HARNESS_TS или entry версии TOOLCHAIN.lock в каталоге тулчейна
# (CLAUDE_HARNESS_TOOLCHAIN, иначе ~/.cache/claude-harness/toolchain) — те же места, что читают src/parsers/ts.ts и
# src/toolchain.ts. Без Node: sed по замку. Caller sets `root`.
harness_ts_present() {
  [ -n "${CLAUDE_HARNESS_TS:-}" ] && [ -f "$CLAUDE_HARNESS_TS" ] && return 0
  ts_ver="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$root/TOOLCHAIN.lock" | head -1)"
  ts_entry="$(sed -n 's/^ *"entry": *"\([^"]*\)".*/\1/p' "$root/TOOLCHAIN.lock" | head -1)"
  ts_dir="${CLAUDE_HARNESS_TOOLCHAIN:-${HOME:-}/.cache/claude-harness/toolchain}"
  [ -n "$ts_ver" ] && [ -n "$ts_entry" ] && [ -f "$ts_dir/typescript@$ts_ver/$ts_entry" ]
}
