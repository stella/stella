#!/usr/bin/env bash
#
# Local mirror of the required package checks in .github/workflows/ci.yml:
# one command that answers "will CI pass?" without reverse-engineering
# the workflow. Green here means green on the required `ci-result`
# check (the separate build/e2e jobs are not included; they need the
# full service stack).
#
# Keep the check list in sync with ci.yml when adding or removing
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
  # tsc processes are memory-hungry; serialize typecheck tasks so
  # parallel instances cannot exhaust memory on contributor machines.
  # CI runs lint and typecheck as separate jobs; results match.
  # The typecheck-cost baseline guard (scripts/typecheck-baseline.ts) is
  # deliberately NOT run here: like the bundle baseline, it re-runs full
  # per-project typechecks and is too slow for the local loop. It runs in
  # its own CI job (typecheck-baseline); its failures point at type-cost growth, not
  # type errors, so a green verify still matches a green typecheck.
  if [[ -n "$affected_flag" ]]; then
    bun run typecheck -- --concurrency=1 "$affected_flag"
  else
    bun run typecheck -- --concurrency=1
  fi
}

run_ratchet_guard() {
  # Whole-repo convention metrics (see RATCHET_METRICS in scripts/ratchet.ts)
  # that may only ever decrease vs a
  # committed baseline. A rise fails; a fall just prompts
  # `bun scripts/ratchet.ts --write`. The --self-test run
  # first proves each counter counts what it claims, so a broken guard cannot
  # pass silently.
  bun scripts/ratchet.ts --self-test || return 1
  bun scripts/ratchet.ts --check
}

run_crawl_posture_guard() {
  # Every app under apps/ declares a `crawlPosture` in package.json (public /
  # private / mixed / unserved), and this guard verifies its crawl artifacts
  # match: public apps ship a crawler-inviting robots.txt plus llms.txt; private
  # apps ship a deny-all robots.txt and per-page noindex; mixed SSR apps serve a
  # dynamic default-deny robots.txt with an explicit public allowlist (checked in
  # source) instead of static files. Keeps the public SEO/LLM surface and the
  # private app from silently drifting. The --self-test run first proves each
  # detector still fires, so a broken guard cannot pass silently.
  bun scripts/crawl-posture.ts --self-test || return 1
  bun scripts/crawl-posture.ts --check
}

run_exact_mirror_guard() {
  # Build the real app and force every route's Elysia exactMirror to compile;
  # fail if any route's schema cannot be mirrored (recursive schemas fall back
  # to slow serialization and have taken the API down at boot). The --self-test
  # run first proves the detector still catches a known recursive schema.
  bun apps/api/scripts/exact-mirror-guard.ts --self-test || return 1
  bun apps/api/scripts/exact-mirror-guard.ts
}

run_mcp_coverage_guard() {
  # Every safe-handler config must declare an `mcp` disposition. This guard
  # imports every handler module, checks each disposition is well-formed, that
  # tool/covered references name real static MCP tools, that no registry tool
  # is orphaned, and that the `pending` baseline can only shrink. The
  # --self-test run first proves the ratchet detectors still fire.
  bun apps/api/scripts/mcp-coverage-guard.ts --self-test || return 1
  bun apps/api/scripts/mcp-coverage-guard.ts
}

run_cli_registry_snapshot() {
  # The stella CLI's committed registry snapshot, generated route map, and the
  # generated TanStack Intent agent skill must match the live MCP registry:
  # regenerate all of them and fail on any diff so a registry change cannot
  # silently ship a stale CLI surface (or stale skill docs).
  (cd packages/cli && bun run codegen) || return 1
  git diff --exit-code -- packages/cli/src/generated packages/cli/skills
}

run_capability_catalog() {
  # The committed capability catalog (every `tool`/`covered` safe handler,
  # projected to id + input schema + permissions + scope + access) must match
  # the live handler graph. `--check` regenerates it in-memory and byte-compares
  # against the committed JSON, so a handler or mapping change cannot silently
  # ship a stale catalog. Regenerate:
  # `bun --env-file=apps/api/.env apps/api/scripts/export-capability-catalog.ts`.
  bun apps/api/scripts/export-capability-catalog.ts --check
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
run_step "Policy evidence" bun run policies:check
run_step "Railway template shape" bun run check:railway-template
run_step "i18n" bun run i18n:check
run_step "Release changelog guard" bash scripts/check-release-changelog.sh --base "$base_ref"
run_step "Lint" run_lint
run_step "Format" run_format
run_step "Rust format" run_rust_format
run_step "Typecheck" run_typecheck
run_step "React Compiler bailout guard" bun scripts/rc-bailouts.ts --check
run_step "Ratchet guard" run_ratchet_guard
run_step "Crawl posture guard" run_crawl_posture_guard
run_step "exactMirror route guard" run_exact_mirror_guard
run_step "MCP coverage guard" run_mcp_coverage_guard
run_step "CLI registry snapshot" run_cli_registry_snapshot
run_step "Capability catalog drift" run_capability_catalog
run_step "Knip production deps" run_knip
run_step "Test" run_test
run_step "Bridge-version guard self-test" bash scripts/check-bridge-version.test.sh
run_step "Release-channel self-test" bash scripts/release-channel.test.sh
run_step "API release contract self-test" bun test \
  --preload ./apps/api/src/tests/setup-env.ts \
  scripts/check-api-cli-contract.test.ts \
  scripts/check-api-deployment.test.ts
run_step "Desktop-release-changes self-test" bash scripts/detect-desktop-release-changes.test.sh
run_step "Bridge-version guard" bash scripts/check-bridge-version.sh

echo
if (( ${#failures[@]} > 0 )); then
  echo "verify: ${#failures[@]} check(s) failed:"
  printf ' - %s\n' "${failures[@]}"
  exit 1
fi
echo "verify: all checks passed"
