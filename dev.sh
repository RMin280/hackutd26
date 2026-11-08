#!/usr/bin/env bash
# Squawk: run the backend (SpacetimeDB) and the control-room view together.
#
#   bash dev.sh server     terminal 1: local SpacetimeDB on :3000 (leave it running)
#   bash dev.sh up         terminal 2: publish the module, then start the view in live mode
#                          then open http://localhost:5173
#
# Other commands:
#   bash dev.sh check      what's installed and running (paste this when asking for help)
#   bash dev.sh publish    rebuild + republish the module (keeps the data unless the schema changed)
#   bash dev.sh fresh      republish and wipe the data: back to the diagnostics test bed
#   bash dev.sh frontend   regenerate bindings and start the view (module already published)
#   bash dev.sh test       backend tests (no SpacetimeDB needed)
#
# SpacetimeDB Maincloud instead of the local server (needs `spacetime login`):
#   bash dev.sh cloud publish    publish the module to Maincloud (keeps the data unless the schema changed)
#   bash dev.sh cloud fresh      republish and wipe the data
#   bash dev.sh cloud frontend   start the view against Maincloud (frontend/.env.maincloud.local)
#   bash dev.sh cloud up         publish, then start the view
#   bash dev.sh cloud lock       close open registration once your screens and agents are registered
#   bash dev.sh cloud unlock     open it again (to register a new browser)
#   bash dev.sh cloud logs       the module's logs on Maincloud
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB="${SQUAWK_DB:-squawk}" # database name on the local server
SERVER=local                          # the spacetime CLI's name for http://127.0.0.1:3000
URI=http://localhost:3000             # what the browser connects to
VITE_MODE=""                          # the view's env file: .env.local, or .env.<mode>.local
if [ "${1:-}" = cloud ]; then
  shift
  # Maincloud's database names are global, so ours carries the event's name.
  DB="${SQUAWK_DB:-squawk-hackutd26}"
  SERVER=maincloud
  URI=https://maincloud.spacetimedb.com
  VITE_MODE=maincloud
fi
YES=--yes=migrate,break-clients,delete-data # answer publish's schema prompts, not the login one

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

need_node() {
  command -v node >/dev/null 2>&1 || die "Node.js isn't installed. Install Node 22 LTS (https://nodejs.org, or: nvm install 22), then re-run."
  command -v npm >/dev/null 2>&1 || die "npm isn't installed (it comes with Node.js)."
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 18 ] || die "Node $(node -v) is too old. Install Node 22 LTS."
  [ "$major" -ge 22 ] || warn "Node $(node -v) should work, but SpacetimeDB recommends Node 22 or newer."
}

cli_version() { # "spacetimedb tool version 2.14.1; ..." -> 2.14.1
  local out v
  out="$(spacetime --version 2>/dev/null || true)"
  v="$(printf '%s\n' "$out" | sed -n 's/.*tool version \([0-9][0-9.]*\).*/\1/p' | head -n 1 || true)"
  [ -n "$v" ] || v="$(printf '%s\n' "$out" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | tail -n 1 || true)"
  printf '%s' "$v"
}

CLI_VERSION=""
need_spacetime() {
  command -v spacetime >/dev/null 2>&1 || die "The spacetime CLI isn't on your PATH.
  Install it:  curl -sSf https://install.spacetimedb.com | sh
  then open a new terminal (the installer adds ~/.local/bin to PATH) and re-run."
  CLI_VERSION="$(cli_version)"
  case "$CLI_VERSION" in
    2.*) ;;
    "") warn "Couldn't read the spacetime CLI version (spacetime --version)." ;;
    *) die "spacetime $CLI_VERSION is installed; this project needs SpacetimeDB 2.x. Run: spacetime version upgrade" ;;
  esac
}

npm_version() { # version of the spacetimedb npm package installed in $1/, if any
  local f="$ROOT/$1/node_modules/spacetimedb/package.json"
  [ -f "$f" ] && node -p "require('$f').version" 2>/dev/null || true
}

check_sdk() { # a module built with a newer SDK than the local server may fail to load
  local sdk
  sdk="$(npm_version spacetimedb)"
  [ -n "$sdk" ] && [ -n "$CLI_VERSION" ] || return 0
  if [ "$(echo "$sdk" | cut -d. -f2)" -gt "$(echo "$CLI_VERSION" | cut -d. -f2)" ]; then
    warn "spacetimedb/ uses the spacetimedb npm package $sdk, newer than your spacetime CLI $CLI_VERSION. If publish fails, run: spacetime version upgrade"
  fi
}

server_up() { spacetime server ping "$SERVER" 2>/dev/null | grep "Server is online" >/dev/null; }

need_server() {
  if [ "$SERVER" = maincloud ]; then
    server_up || die "Can't reach Maincloud (spacetime server ping maincloud). Check the network."
    spacetime login show 2>/dev/null | grep "logged in as" >/dev/null || die "Log in first: spacetime login"
    return 0
  fi
  server_up || die "SpacetimeDB isn't running. Start it in another terminal and leave it open:
  bash dev.sh server"
}

ensure_deps() { # npm install in $1/ when node_modules is missing or older than package.json
  local dir="$ROOT/$1"
  if [ ! -f "$dir/node_modules/.package-lock.json" ] || [ "$dir/package.json" -nt "$dir/node_modules/.package-lock.json" ]; then
    step "Installing npm packages in $1/"
    (cd "$dir" && npm install) || die "npm install failed in $1/ (see above)."
  fi
}

login_hint() {
  if spacetime login show 2>/dev/null | grep "not logged in" >/dev/null; then
    echo
    echo "You're not logged in to the spacetime CLI, so publish will ask:"
    echo "  \"Would you like to log in with spacetimedb.com?\"  Press Enter and finish in your browser."
    echo "  The login is free and also works with this local server."
  fi
}

publish() { # extra args go to spacetime publish
  need_node
  need_spacetime
  ensure_deps spacetimedb
  check_sdk
  need_server
  login_hint
  step "Building and publishing the module to '$SERVER' as '$DB'"
  local remote=()
  [ "$SERVER" = maincloud ] && remote=(--yes=remote) # you asked for the cloud: skip "publish to a non-local server?"
  (cd "$ROOT" && spacetime publish --server "$SERVER" --module-path spacetimedb "$DB" "$@" ${remote[@]+"${remote[@]}"}) || die "Publish failed (see above).
  TypeScript errors:  (cd spacetimedb && npx tsc --noEmit)
  Errors from init:   spacetime logs --server $SERVER $DB"
  echo "Published. Server logs: spacetime logs --server $SERVER $DB"
}

write_env() {
  local name=.env.local
  [ -n "$VITE_MODE" ] && name=".env.$VITE_MODE.local"
  local env="$ROOT/frontend/$name"
  [ -f "$env" ] && return 0
  printf 'VITE_SPACETIMEDB_URI=%s\nVITE_SPACETIMEDB_DB=%s\n' "$URI" "$DB" >"$env"
  echo "Wrote frontend/$name (live mode against $SERVER)."
}

frontend() {
  need_node
  need_spacetime
  ensure_deps spacetimedb # spacetime generate builds the module first
  ensure_deps frontend
  step "Generating client bindings into frontend/src/module_bindings"
  (cd "$ROOT/frontend" && npm run bindings) || die "spacetime generate failed (see above)."
  write_env
  server_up || warn "SpacetimeDB ($SERVER) isn't reachable, so the view will say it can't connect."
  step "Starting the control-room view against $SERVER ($DB): http://localhost:5173 (Ctrl+C stops it)"
  cd "$ROOT/frontend"
  if [ -n "$VITE_MODE" ]; then exec npm run dev -- --mode "$VITE_MODE"; fi
  exec npm run dev
}

set_registration() { # true | false
  need_spacetime
  need_server
  spacetime call --server "$SERVER" "$DB" set_open_registration "$1" || die "Couldn't change registration (only the admin, the identity that first published, may)."
  if [ "$1" = false ]; then
    echo "Open registration is off on $DB: new browsers and agents need: spacetime call --server $SERVER $DB register_actor <identity> <name> <role> []"
  else
    echo "Open registration is on: any browser that connects can register itself as a shift lead. Lock it again when done: bash dev.sh cloud lock"
  fi
}

cmd_server() {
  need_spacetime
  if server_up; then
    echo "SpacetimeDB is already running. Next, in another terminal: bash dev.sh up"
    return 0
  fi
  step "Starting SpacetimeDB on :3000. Leave this terminal open (Ctrl+C stops it)."
  echo "Next, in another terminal: bash dev.sh up"
  exec spacetime start
}

cmd_check() {
  echo "repo:       $ROOT"
  if command -v node >/dev/null 2>&1; then echo "node:       $(node -v)"; else echo "node:       MISSING (install Node 22 LTS)"; fi
  if command -v npm >/dev/null 2>&1; then echo "npm:        $(npm -v)"; else echo "npm:        MISSING"; fi
  if command -v spacetime >/dev/null 2>&1; then
    echo "spacetime:  $(cli_version) ($(command -v spacetime))"
    if server_up; then echo "server:     running"; else echo "server:     not running (bash dev.sh server)"; fi
    echo "login:      $(spacetime login show 2>/dev/null | head -n 1 || true)"
  else
    echo "spacetime:  MISSING (curl -sSf https://install.spacetimedb.com | sh)"
  fi
  local d v
  for d in spacetimedb frontend; do
    v="$(npm_version "$d")"
    echo "$d/: spacetimedb npm package ${v:-not installed (npm install)}"
  done
  if grep "AUTOMATICALLY GENERATED" "$ROOT/frontend/src/module_bindings/index.ts" >/dev/null 2>&1; then
    echo "bindings:   generated"
  else
    echo "bindings:   placeholder (bash dev.sh frontend generates them)"
  fi
  if [ -f "$ROOT/frontend/.env.local" ]; then
    echo "view mode:  live ($(tr '\n' ' ' <"$ROOT/frontend/.env.local"))"
  else
    echo "view mode:  mock (no frontend/.env.local)"
  fi
}

cmd_test() {
  need_node
  ensure_deps spacetimedb
  cd "$ROOT/spacetimedb"
  npm test
}

case "${1:-help}" in
  server) cmd_server ;;
  up)
    publish --delete-data=on-conflict "$YES"
    frontend
    ;;
  publish) publish --delete-data=on-conflict "$YES" ;;
  fresh) publish --delete-data "$YES" ;;
  frontend) frontend ;;
  check) cmd_check ;;
  test) cmd_test ;;
  lock) set_registration false ;;
  unlock) set_registration true ;;
  logs) spacetime logs --server "$SERVER" "$DB" ;;
  help | -h | --help) sed -n '2,22p' "$ROOT/dev.sh" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command '$1' (try: bash dev.sh help)" ;;
esac
