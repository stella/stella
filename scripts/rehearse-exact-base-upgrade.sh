#!/usr/bin/env bash
# Rehearse the merge queue's exact base schema before applying this checkout.
# DATABASE_URL must point to an empty, disposable local PostgreSQL database.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${CLEAN_DATABASE_URL:?CLEAN_DATABASE_URL is required for an isolated clean cluster}"
: "${BASE_SHA:?BASE_SHA must identify the merge-group base commit}"
overall_started="$(date +%s)"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
ruleset="$repo_root/.github/branch-protection/ruleset-main.json"

log() {
  printf '==> %s\n' "$*"
}

fail() {
  printf '::error::%s\n' "$*" >&2
  exit 1
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
cleanup() {
  if [[ -d "$base_dir" ]]; then
    git -C "$repo_root" worktree remove --force "$base_dir" >/dev/null 2>&1 || true
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT

log "Checking out exact base $base_commit"
git -C "$repo_root" worktree add --detach "$base_dir" "$base_commit"

log "Installing the base's pinned dependencies"
(cd "$base_dir" && NPM_TOKEN='' bun ci --ignore-scripts)

# Keep the database credentials in URLs, never in output. A fresh database
# name makes a stale local run fail rather than reusing its migrated state.
database_url_for() {
  # ShellCheck cannot see that these expressions belong to Bun, not Bash.
  # shellcheck disable=SC2016
  SOURCE_URL="$1" TARGET_DATABASE="$2" bun -e '
    const url = new URL(process.env.SOURCE_URL);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) process.exit(2);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) process.exit(2);
    url.pathname = `/${process.env.TARGET_DATABASE}`;
    console.log(url.toString());
  '
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
  DATABASE_URL="$1" TARGET_DATABASE="$2" bun -e '
    import { SQL } from "bun";
    const database = process.env.TARGET_DATABASE;
    if (database !== "upgrade" && database !== "clean") process.exit(2);
    const client = new SQL({ url: process.env.DATABASE_URL, max: 1 });
    try { await client.unsafe(`CREATE DATABASE ${database}`); }
    finally { await client.end(); }
  '
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

started="$(date +%s)"
log "Migrating the exact base into upgrade"
run_migrate "$base_dir" "$upgrade_url"
base_seconds=$(( $(date +%s) - started ))
snapshot "$upgrade_url" "$scratch/base-before-seed.json"

started="$(date +%s)"
log "Seeding the base schema with its own seeder"
(cd "$base_dir/apps/api" && DATABASE_URL="$upgrade_url" bun run src/scripts/seed-migration-rehearsal.ts --decisions 10)
seed_seconds=$(( $(date +%s) - started ))
snapshot "$upgrade_url" "$scratch/base-after-seed.json"
bun "$repo_root/scripts/migration-catalog.ts" seed-footprint \
  "$scratch/base-before-seed.json" "$scratch/base-after-seed.json" >"$scratch/seeded-tables.txt"

started="$(date +%s)"
log "Migrating the candidate into upgrade and clean"
run_migrate "$repo_root" "$upgrade_url"
run_migrate "$repo_root" "$clean_url"
candidate_seconds=$(( $(date +%s) - started ))

log "Comparing upgraded and clean catalogs"
snapshot "$upgrade_url" "$scratch/upgrade.json"
snapshot "$clean_url" "$scratch/clean.json"
bun "$repo_root/scripts/migration-catalog.ts" compare "$scratch/upgrade.json" "$scratch/clean.json" \
  --exclude-data-tables "$scratch/seeded-tables.txt" \
  || fail "The exact-base upgrade and clean migration catalogs differ."

upgrade_digest="$(digest "$upgrade_url")"
clean_digest="$(digest "$clean_url")"

started="$(date +%s)"
log "Rerunning the candidate on both databases"
run_migrate "$repo_root" "$upgrade_url"
run_migrate "$repo_root" "$clean_url"
rerun_seconds=$(( $(date +%s) - started ))

[[ "$upgrade_digest" == "$(digest "$upgrade_url")" ]] \
  || fail "The upgrade database changed on rerun."
[[ "$clean_digest" == "$(digest "$clean_url")" ]] \
  || fail "The clean database changed on rerun."

snapshot "$upgrade_url" "$scratch/upgrade-rerun.json"
snapshot "$clean_url" "$scratch/clean-rerun.json"
bun "$repo_root/scripts/migration-catalog.ts" compare "$scratch/upgrade.json" "$scratch/upgrade-rerun.json" \
  || fail "The upgrade catalog changed on rerun."
bun "$repo_root/scripts/migration-catalog.ts" compare "$scratch/clean.json" "$scratch/clean-rerun.json" \
  || fail "The clean catalog changed on rerun."

{
  echo "### Exact-base migration upgrade"
  echo
  echo "| Step | Result |"
  echo "| --- | --- |"
  echo "| Base | \`$base_commit\` |"
  echo "| Base migrate | ${base_seconds}s |"
  echo "| Base seed | ${seed_seconds}s (10 decisions) |"
  echo "| Seed footprint | $(wc -l <"$scratch/seeded-tables.txt" | tr -d ' ') additional tables excluded from cross-path row comparison |"
  echo "| Candidate upgrade and clean | ${candidate_seconds}s; catalogs match |"
  echo "| Rerun | ${rerun_seconds}s; digests and catalogs unchanged |"
  echo "| Total rehearsal | $(( $(date +%s) - overall_started ))s |"
} | tee -a "$summary"
