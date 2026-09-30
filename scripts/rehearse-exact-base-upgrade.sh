#!/usr/bin/env bash
# Rehearse the merge queue's exact base schema before applying this checkout.
# DATABASE_URL must point to an empty, disposable local PostgreSQL database.
set -euo pipefail

overall_started="$(date +%s)"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
ruleset="$repo_root/.github/branch-protection/ruleset-main.json"
base_commit="${BASE_SHA:-unset}"
candidate_commit="unavailable"
scratch=""
base_dir=""
first_difference=""
verdict="infra failure"
phase_names=("Prepare" "Base migrate" "Base seed" "Candidate migrate" "Compare catalogs" "Rerun" "Compare rerun")
phase_seconds=("not run" "not run" "not run" "not run" "not run" "not run" "not run")
phase_index=-1
phase_started=$overall_started

finish_phase() {
  if (( phase_index >= 0 )); then
    phase_seconds[phase_index]="$(( $(date +%s) - phase_started ))s"
  fi
}

start_phase() {
  finish_phase
  phase_index=$1
  phase_started="$(date +%s)"
}

finish() {
  local status=$?
  local index
  finish_phase
  if [[ "$status" == 0 ]]; then
    verdict="pass"
  elif [[ "$verdict" == "drift found" ]]; then
    status=2
  else
    status=1
  fi
  {
    echo "### Exact-base migration upgrade"
    echo
    echo "| Step | Result |"
    echo "| --- | --- |"
    echo "| Verdict | $verdict |"
    echo "| Base | \`$base_commit\` |"
    echo "| Candidate | \`$candidate_commit\` |"
    for index in "${!phase_names[@]}"; do
      echo "| ${phase_names[$index]} | ${phase_seconds[$index]} |"
    done
    echo "| Total rehearsal | $(( $(date +%s) - overall_started ))s |"
    if [[ -n "$first_difference" ]]; then
      printf '\nFirst difference: %s\n' "$first_difference"
    fi
  } | tee -a "$summary"
  if [[ -n "$base_dir" && -d "$base_dir" ]]; then
    git -C "$repo_root" worktree remove --force "$base_dir" >/dev/null 2>&1 || true
  fi
  if [[ -n "$scratch" ]]; then
    rm -rf "$scratch"
  fi
  exit "$status"
}
trap finish EXIT
start_phase 0
candidate_commit="$(git -C "$repo_root" rev-parse HEAD)"
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${CLEAN_DATABASE_URL:?CLEAN_DATABASE_URL is required for an isolated clean cluster}"
: "${BASE_SHA:?BASE_SHA must identify the merge-group base commit}"

log() {
  printf '==> %s\n' "$*"
}

fail() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

# Exit 2 is reserved for observed drift; execution/configuration errors use 1.
drift() {
  verdict="drift found"
  first_difference=$1
  printf '::warning::%s\n' "$first_difference" >&2
  exit 2
}

compare_digests() {
  local label=$1
  local before=$2
  local after=$3
  local before_items after_items index count
  [[ "$before" != "$after" ]] || return 0
  read -r -a before_items <<<"$before"
  read -r -a after_items <<<"$after"
  count=${#before_items[@]}
  if (( ${#after_items[@]} > count )); then
    count=${#after_items[@]}
  fi
  for (( index=0; index<count; index++ )); do
    if [[ "${before_items[$index]:-missing}" != "${after_items[$index]:-missing}" ]]; then
      drift "$label digest: ${before_items[$index]:-missing} != ${after_items[$index]:-missing}"
    fi
  done
}

compare_catalogs() {
  local status
  if bun "$repo_root/scripts/migration-catalog.ts" compare "$@" >"$scratch/comparison.txt" 2>&1; then
    cat "$scratch/comparison.txt"
    return
  else
    status=$?
  fi
  cat "$scratch/comparison.txt" >&2
  if [[ "$status" == 2 ]]; then
    IFS= read -r first_difference <"$scratch/comparison.txt" || true
    drift "$first_difference"
  fi
  fail "Catalog comparison could not complete."
}

if ! jq -e '[.rules[] | select(.type == "merge_queue") | .parameters.max_entries_to_build] == [1]' "$ruleset" >/dev/null; then
  fail "The checked-in merge queue ruleset must set max_entries_to_build to 1."
fi
[[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "BASE_SHA must be a full commit SHA."

base_commit="$(git -C "$repo_root" rev-parse --verify "${BASE_SHA}^{commit}" 2>/dev/null)" \
  || fail "BASE_SHA does not identify an available commit."

# The worktree and snapshots live outside the checkout, and are removed even
# when a migration or comparison fails.
scratch="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/exact-base-upgrade.XXXXXX")"
base_dir="$scratch/base"
log "Checking out exact base $base_commit"
git -C "$repo_root" worktree add --detach "$base_dir" "$base_commit"

log "Installing the base's pinned dependencies"
(cd "$base_dir" && NPM_TOKEN='' bun ci --ignore-scripts)

# Keep the database credentials in URLs, never in output. A fresh database
# name makes a stale local run fail rather than reusing its migrated state.
database_url_for() {
  # ShellCheck cannot see that these expressions belong to Bun, not Bash.
  # shellcheck disable=SC2016
  DATABASE_URL="$1" bun -e '
    const url = new URL(process.env.DATABASE_URL);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) process.exit(2);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) process.exit(2);
    url.pathname = `/${process.argv.at(1)}`;
    console.log(url.toString());
  ' "$2"
}

upgrade_url="$(database_url_for "$DATABASE_URL" upgrade)" || fail "DATABASE_URL must be a loopback PostgreSQL URL."
clean_url="$(database_url_for "$CLEAN_DATABASE_URL" clean)" || fail "CLEAN_DATABASE_URL must be a loopback PostgreSQL URL."
[[ "${upgrade_url%/*}" != "${clean_url%/*}" ]] \
  || fail "Upgrade and clean must use separate PostgreSQL clusters because migrations create cluster-wide roles."

log "Checking that the source database is empty"
bun "$repo_root/scripts/migration-rehearsal-db.ts" assert-empty
DATABASE_URL="$CLEAN_DATABASE_URL" bun "$repo_root/scripts/migration-rehearsal-db.ts" assert-empty

log "Creating upgrade and clean databases"
create_database() {
  # shellcheck disable=SC2016
  DATABASE_URL="$1" bun -e '
    import { SQL } from "bun";
    const database = process.argv.at(1);
    if (database !== "upgrade" && database !== "clean") process.exit(2);
    const client = new SQL({ url: process.env.DATABASE_URL, max: 1 });
    try { await client.unsafe(`CREATE DATABASE ${database}`); }
    finally { await client.end(); }
  ' "$2"
}
create_database "$DATABASE_URL" upgrade
create_database "$CLEAN_DATABASE_URL" clean

run_migrate() {
  local checkout="$1"
  local url="$2"
  (cd "$checkout/apps/api" && DATABASE_URL="$url" bun run src/db/migrate.ts)
}

snapshot() {
  local url="$1"
  local output="$2"
  DATABASE_URL="$url" bun "$repo_root/scripts/migration-catalog.ts" snapshot >"$output"
}

digest() {
  local url="$1"
  DATABASE_URL="$url" bun "$repo_root/scripts/migration-rehearsal-db.ts" digest
}

start_phase 1
log "Migrating the exact base into upgrade"
run_migrate "$base_dir" "$upgrade_url"
snapshot "$upgrade_url" "$scratch/base-before-seed.json"

start_phase 2
log "Seeding the base schema with its own seeder"
(cd "$base_dir/apps/api" && DATABASE_URL="$upgrade_url" bun run src/scripts/seed-migration-rehearsal.ts --decisions 10)
snapshot "$upgrade_url" "$scratch/base-after-seed.json"
bun "$repo_root/scripts/migration-catalog.ts" seed-footprint \
  "$scratch/base-before-seed.json" "$scratch/base-after-seed.json" >"$scratch/seeded-tables.txt"

start_phase 3
log "Migrating the candidate into upgrade and clean"
run_migrate "$repo_root" "$upgrade_url"
run_migrate "$repo_root" "$clean_url"

start_phase 4
log "Comparing upgraded and clean catalogs"
snapshot "$upgrade_url" "$scratch/upgrade.json"
snapshot "$clean_url" "$scratch/clean.json"
compare_catalogs "$scratch/upgrade.json" "$scratch/clean.json" \
  --exclude-data-tables "$scratch/seeded-tables.txt"

upgrade_digest="$(digest "$upgrade_url")"
clean_digest="$(digest "$clean_url")"

start_phase 5
log "Rerunning the candidate on both databases"
run_migrate "$repo_root" "$upgrade_url"
run_migrate "$repo_root" "$clean_url"

start_phase 6
upgrade_rerun_digest="$(digest "$upgrade_url")"
clean_rerun_digest="$(digest "$clean_url")"
compare_digests upgrade "$upgrade_digest" "$upgrade_rerun_digest"
compare_digests clean "$clean_digest" "$clean_rerun_digest"

snapshot "$upgrade_url" "$scratch/upgrade-rerun.json"
snapshot "$clean_url" "$scratch/clean-rerun.json"
compare_catalogs "$scratch/upgrade.json" "$scratch/upgrade-rerun.json"
compare_catalogs "$scratch/clean.json" "$scratch/clean-rerun.json"
