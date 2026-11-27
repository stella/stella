#!/usr/bin/env bash
set -eo pipefail
target="$1"
url_file="$RUNNER_TEMP/desktop-smoke-url"
bun apps/api/scripts/desktop-registry-transport-smoke-server.ts "$url_file" &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
for _ in {1..100}; do
  test -s "$url_file" && break
  kill -0 "$server_pid" 2>/dev/null || { wait "$server_pid"; exit 1; }
  sleep 0.1
done
test -s "$url_file"
STELLA_DESKTOP_SMOKE_API_URL="$(cat "$url_file")" cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib --target "$target" --frozen registry::tests::native_desktop_transport_reaches_api_authentication -- --ignored --exact
wait "$server_pid"
