#!/bin/sh
# Единственный шаг zero-install: найти Node >= 24, взять TypeScript из тулчейна харнесса (TOOLCHAIN.lock), записать пути в ~/.claude/env/harness.env,
# создать симлинк ~/.claude/harness → этот каталог, прогреть compile cache, поставить WAL на базе состояния.
# Нет тулчейна TypeScript — ставит его по TOOLCHAIN.lock (integrity + sha256; без него гейты на TS-AST отвечают unknown).
# Node качает только с --ensure-node. Повторный запуск идемпотентен. --clean сбрасывает compile cache.
set -eu
here="$(cd "$(dirname "$0")" && pwd -P)"
envdir="$HOME/.claude/env"; envfile="$envdir/harness.env"
state="${CLAUDE_STATE_DIR:-$HOME/.claude/exec-telemetry}"
node_bin="${1:-}"
ensure=0
[ "$node_bin" = "--clean" ] && { rm -rf "$state/compile-cache"; echo "compile cache сброшен"; node_bin=""; }
[ "$node_bin" = "--node" ] && node_bin="${2:-}"
[ "$node_bin" = "--ensure-node" ] && { ensure=1; node_bin=""; }

# --ensure-node: Node >= 24 нет ни в nvm, ни в PATH, ни в приватном каталоге харнесса — скачать официальную сборку
# в $HOME/.claude/env/node/<версия>/ с проверкой SHASUMS256. Только для харнесса: PATH, default nvm и системный
# node других проектов не трогаются. Повторный вызов находит уже скачанную сборку и ничего не качает.
ensure_node() {
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"; arch="$(uname -m)"
  case "$arch" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo "ensure-node: архитектура $arch не поддерживается" >&2; return 1 ;; esac
  case "$os" in darwin|linux) ;; *) echo "ensure-node: ОС $os не поддерживается" >&2; return 1 ;; esac
  sums="$(curl -fsSL --max-time 30 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt)" || { echo "ensure-node: nodejs.org недоступен" >&2; return 1; }
  line="$(printf '%s\n' "$sums" | grep -E "node-v24\.[0-9]+\.[0-9]+-$os-$arch\.tar\.gz$" | head -1)"
  [ -n "$line" ] || { echo "ensure-node: сборки для $os-$arch нет в latest-v24.x" >&2; return 1; }
  sum="${line%% *}"; file="${line##* }"; ver="${file#node-}"; ver="${ver%%-*}"
  dest="$envdir/node/$ver"
  if [ -x "$dest/bin/node" ]; then node_bin="$dest/bin/node"; return 0; fi
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/harness-node.XXXXXX")"
  curl -fsSL --max-time 600 -o "$tmp/$file" "https://nodejs.org/dist/latest-v24.x/$file" || { echo "ensure-node: не скачалось $file" >&2; rm -rf "$tmp"; return 1; }
  got="$( (command -v sha256sum >/dev/null 2>&1 && sha256sum "$tmp/$file" || shasum -a 256 "$tmp/$file") | cut -d' ' -f1)"
  [ "$got" = "$sum" ] || { echo "ensure-node: sha256 не совпал у $file" >&2; rm -rf "$tmp"; return 1; }
  mkdir -p "$envdir/node" && tar -xzf "$tmp/$file" -C "$tmp" && rm -rf "$dest" && mv "$tmp/${file%.tar.gz}" "$dest" && rm -rf "$tmp"
  node_bin="$dest/bin/node"
  echo "ensure-node: $ver скачан в $dest (PATH и nvm не тронуты)"
}

if [ -z "$node_bin" ]; then
  node_bin="$(CLAUDE_HARNESS_NODE= HOME="$HOME" sh -c '
    best=0; pick=""
    for cand in "$HOME"/.nvm/versions/node/v*/bin/node "$HOME"/.claude/env/node/v*/bin/node /usr/local/bin/node /opt/homebrew/bin/node "$(command -v node 2>/dev/null)"; do
      [ -x "$cand" ] || continue
      v="$("$cand" -v 2>/dev/null)"; v="${v#v}"; maj="${v%%.*}"; rest="${v#*.}"; min="${rest%%.*}"; pat="${rest#*.}"
      case "$maj$min$pat" in *[!0-9]*) continue ;; esac
      [ "$maj" -ge 24 ] || continue
      key=$(( maj * 1000000 + min * 1000 + pat )); [ "$key" -gt "$best" ] && { best=$key; pick="$cand"; }
    done; printf "%s" "$pick"')"
fi
if [ -z "$node_bin" ] && [ "$ensure" = 1 ]; then ensure_node || exit 1; fi
[ -n "$node_bin" ] && [ -x "$node_bin" ] || { echo "Node >= 24 не найден. Варианты: install.sh --ensure-node (приватная сборка в ~/.claude/env/node), nvm install 24, install.sh --node /путь/к/node" >&2; exit 1; }
ts_check() { "$node_bin" --disable-warning=ExperimentalWarning "$here/scripts/toolchain.ts" --check 2>/dev/null || true; }
ts_lib="$(ts_check)"
if [ -z "$ts_lib" ]; then
  "$node_bin" --disable-warning=ExperimentalWarning "$here/scripts/toolchain.ts" --install >/dev/null && ts_lib="$(ts_check)"
  [ -n "$ts_lib" ] || echo "тулчейн TypeScript (TOOLCHAIN.lock) не установился: $node_bin $here/scripts/toolchain.ts --install — до установки гейты на TS-AST отвечают unknown" >&2
fi
mkdir -p "$envdir" "$state/compile-cache" "$state/markers"
{
  echo "# Харнесс — машинно-специфичный пин рантайма; вне git. Перегенерировать: harness/install.sh"
  echo "CLAUDE_HARNESS_NODE=$node_bin"
  [ -n "$ts_lib" ] && echo "CLAUDE_HARNESS_TS=$ts_lib"
} > "$envfile"
ln -sfn "$here" "$HOME/.claude/harness"
NODE_COMPILE_CACHE="$state/compile-cache" HARNESS_ROOT="$here" "$node_bin" --disable-warning=ExperimentalWarning "$here/src/main.ts" install-warmup </dev/null
root="$here"; . "$here/bin/node-pin.sh"; harness_pin_config
site="${CLAUDE_HARNESS_CONFIG:-$HOME/.claude/harness.config.json}"; [ -e "$site" ] || site="нет — дженерик-дефолты (защищена main)"
echo "harness: node=$node_bin ts=${ts_lib:-нет} env=$envfile link=$HOME/.claude/harness config=$site"
