#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RENDERER="$SCRIPT_DIR/render-web-build-args.sh"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

printf '%s\n' '{"version":1,"variables":{"VITE_ALPHA":"PUBLIC_ALPHA","VITE_BETA":"VITE_BETA"}}' >"$TEMP_DIR/contract.json"
printf '%s\n' '{"version":1,"targetEnvironment":"staging","variables":{"VITE_ALPHA":"enabled"}}' >"$TEMP_DIR/configuration.json"

actual="$(bash "$RENDERER" "$TEMP_DIR/contract.json" "$TEMP_DIR/configuration.json")"
expected=$'PUBLIC_ALPHA=enabled\nVITE_BETA='
if [[ "$actual" != "$expected" ]]; then
  echo "ERROR: renderer did not follow the declared contract." >&2
  diff -u <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") || true
  exit 1
fi

omitted="$(bash "$RENDERER" "$TEMP_DIR/contract.json" "$TEMP_DIR/configuration.json" VITE_BETA)"
if [[ "$omitted" != "PUBLIC_ALPHA=enabled" ]]; then
  echo "ERROR: renderer did not omit the separately supplied variable." >&2
  exit 1
fi

printf '%s\n' '{"version":1,"targetEnvironment":"staging","variables":{"VITE_RETIRED":"enabled"}}' >"$TEMP_DIR/unknown.json"
if bash "$RENDERER" "$TEMP_DIR/contract.json" "$TEMP_DIR/unknown.json" \
  >"$TEMP_DIR/unknown.stdout" 2>"$TEMP_DIR/unknown.stderr"; then
  echo "ERROR: renderer accepted a variable absent from the contract." >&2
  exit 1
fi
grep -Fq "VITE_RETIRED" "$TEMP_DIR/unknown.stderr"

printf '%s\n' '{"version":1,"targetEnvironment":"staging","variables":{"VITE_ALPHA":"first\nsecond"}}' >"$TEMP_DIR/newline.json"
if bash "$RENDERER" "$TEMP_DIR/contract.json" "$TEMP_DIR/newline.json" >/dev/null 2>&1; then
  echo "ERROR: renderer accepted a multiline build argument." >&2
  exit 1
fi

echo "ok - web build arguments follow the public contract"
