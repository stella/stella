#!/usr/bin/env bash
#
# Local mirror of the `ci-checks` job in .github/workflows/ci.yml:
# one command that answers "will CI pass?" without reverse-engineering
# the workflow. Green here means green on the required `ci-result`
# check (the separate build/e2e jobs are not included; they need the
# full service stack).
#
# Keep the step list in sync with ci.yml when adding or removing
# checks there.
#
# Usage:
#   bun run verify           # affected packages vs origin/main (CI PR behavior)
#   bun run verify --all     # full run, no --affected (CI nightly behavior)
set -uo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
cd "$repo_root"

affected_flag="--affected"
base_ref="origin/main"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)
      affected_flag=""
      shift
      ;;
    --base)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "Error: --base requires an argument" >&2
        exit 1
      fi
      base_ref="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: bun run verify [--all] [--base <ref>]" >&2
      exit 1
      ;;
  esac
done

if [[ -n "$affected_flag" ]]; then
  export TURBO_SCM_BASE="$base_ref"
fi

# CI seeds .env from .env.example before running checks; do the same
# for fresh clones, but never touch an existing .env.
for app in apps/api apps/web; do
  if [[ ! -f "$app/.env" && -f "$app/.env.example" ]]; then
    cp "$app/.env.example" "$app/.env"
    echo "Seeded $app/.env from .env.example"
  fi
done

failures=()

run_step() {
  local name="$1"
  shift
  echo
  echo "=== $name ==="
  if "$@"; then
    echo "--- $name: ok"
  else
    echo "--- $name: FAILED"
    failures+=("$name")
  fi
}

run_lint() {
  if [[ -n "$affected_flag" ]]; then
    bun run lint -- "$affected_flag"
  else
    bun run lint
  fi
}

run_format() {
  # Call turbo directly: the package `format` scripts take `--check`
  # after `--`, so the affected flag must land before it.
  if [[ -n "$affected_flag" ]]; then
    bun --bun turbo run format "$affected_flag" -- --check
  else
    bun --bun turbo run format -- --check
  fi
}

run_rust_format() {
  if ! command -v cargo >/dev/null 2>&1; then
    echo "cargo not installed; skipping (CI still checks Rust formatting)"
    return 0
  fi
  cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
}

run_typecheck() {
  # tsgo processes are memory-hungry; serialize typecheck tasks so
  # parallel instances cannot exhaust memory on contributor machines.
  # CI runs them concurrently on isolated runners; results match.
  if [[ -n "$affected_flag" ]]; then
    bun run typecheck -- --concurrency=1 "$affected_flag"
  else
    bun run typecheck -- --concurrency=1
  fi
}

run_knip() {
  local workspace
  for workspace in apps/api apps/legal-atlas-runner apps/web; do
    bun run knip --production --strict --no-progress \
      --include unlisted,unresolved --workspace "$workspace" || return 1
  done
}

run_test() {
  if [[ -n "$affected_flag" ]]; then
    bun run test -- --concurrency=2 "$affected_flag"
  else
    bun run test -- --concurrency=2
  fi
}

run_step "AI skill sync" bash scripts/sync-ai-skills.sh --check
run_step "Workspace hygiene" bun run lint:ws
run_step "i18n" bun run i18n:check
run_step "Release changelog guard" bash scripts/check-release-changelog.sh --base "$base_ref"
run_step "Lint" run_lint
run_step "Format" run_format
run_step "Rust format" run_rust_format
run_step "Typecheck" run_typecheck
run_step "Knip production deps" run_knip
run_step "Test" run_test
run_step "Bridge-version guard self-test" bash scripts/check-bridge-version.test.sh
run_step "Release-channel self-test" bash scripts/release-channel.test.sh
run_step "Bridge-version guard" bash scripts/check-bridge-version.sh

echo
if (( ${#failures[@]} > 0 )); then
  echo "verify: ${#failures[@]} check(s) failed:"
  printf ' - %s\n' "${failures[@]}"
  exit 1
fi
echo "verify: all checks passed"
