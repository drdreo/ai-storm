#!/usr/bin/env sh
# ai-storm installer for Linux/macOS (issue #216).
#
#   curl -fsSL https://raw.githubusercontent.com/drdreo/ai-storm/main/scripts/install.sh | sh
#
# What it does:
#   1. Verifies git, Node >= 22.18 and pnpm (enabling pnpm via corepack when possible)
#   2. Clones (or updates) the repo into ~/.ai-storm/app
#   3. Installs dependencies and builds the client bundle
#   4. Puts an `ai-storm` shim on your PATH (~/.local/bin)
#
# Overridable via environment:
#   AI_STORM_HOME    install root         (default: ~/.ai-storm)
#   AI_STORM_REPO    git URL to clone     (default: https://github.com/drdreo/ai-storm.git)
#   AI_STORM_BRANCH  branch to check out  (default: main)

set -eu

AI_STORM_HOME="${AI_STORM_HOME:-$HOME/.ai-storm}"
AI_STORM_REPO="${AI_STORM_REPO:-https://github.com/drdreo/ai-storm.git}"
AI_STORM_BRANCH="${AI_STORM_BRANCH:-main}"
APP_DIR="$AI_STORM_HOME/app"
BIN_DIR="${AI_STORM_BIN:-$HOME/.local/bin}"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=18

say()  { printf '\033[1m[ai-storm]\033[0m %s\n' "$1"; }
die()  { printf '\033[31m[ai-storm] error:\033[0m %s\n' "$1" >&2; exit 1; }

# --- 1. prerequisites --------------------------------------------------------

command -v git >/dev/null 2>&1 || die "git is required. Install it and re-run."

command -v node >/dev/null 2>&1 || die "Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} is required (24 LTS recommended): https://nodejs.org"
NODE_VERSION="$(node -v | sed 's/^v//')"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | cut -d. -f1)"
NODE_MINOR="$(printf '%s' "$NODE_VERSION" | cut -d. -f2)"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] || { [ "$NODE_MAJOR" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$MIN_NODE_MINOR" ]; }; then
  die "Node v$NODE_VERSION is too old — ai-storm needs >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} (24 LTS recommended): https://nodejs.org"
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    say "pnpm not found — enabling it via corepack…"
    corepack enable pnpm >/dev/null 2>&1 || true
  fi
  command -v pnpm >/dev/null 2>&1 || die "pnpm is required: https://pnpm.io/installation (or: corepack enable pnpm)"
fi

# tmux is a hard runtime requirement on POSIX (durable sessions, PRD §3.5).
if ! command -v tmux >/dev/null 2>&1; then
  say "warning: tmux not found — install it before starting (apt/dnf install tmux, brew install tmux)."
fi

# --- 2. clone or update ------------------------------------------------------

if [ -d "$APP_DIR/.git" ]; then
  say "Updating existing install in $APP_DIR…"
  git -C "$APP_DIR" fetch origin "$AI_STORM_BRANCH"
  git -C "$APP_DIR" checkout "$AI_STORM_BRANCH" >/dev/null 2>&1
  git -C "$APP_DIR" pull --ff-only origin "$AI_STORM_BRANCH"
else
  say "Cloning $AI_STORM_REPO ($AI_STORM_BRANCH) into $APP_DIR…"
  mkdir -p "$AI_STORM_HOME"
  git clone --branch "$AI_STORM_BRANCH" --depth 1 "$AI_STORM_REPO" "$APP_DIR"
fi

# --- 3. install + build ------------------------------------------------------

say "Installing dependencies…"
( cd "$APP_DIR" && pnpm install )
say "Building the client bundle…"
( cd "$APP_DIR" && pnpm build )

# --- 4. shim on PATH ---------------------------------------------------------

mkdir -p "$BIN_DIR"
SHIM="$BIN_DIR/ai-storm"
cat > "$SHIM" <<EOF
#!/usr/bin/env sh
exec node "$APP_DIR/packages/cli/bin/ai-storm.ts" "\$@"
EOF
chmod +x "$SHIM"
say "Installed the ai-storm command at $SHIM"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    say "warning: $BIN_DIR is not on your PATH. Add this to your shell profile:"
    printf '    export PATH="%s:$PATH"\n' "$BIN_DIR"
    ;;
esac

say "Done! Check your setup with:  ai-storm doctor"
say "Then start the app with:      ai-storm"
