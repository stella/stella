#!/usr/bin/env bash
#
# Rehearse this checkout's database upgrade the way a promotion runs it.
#
# A fresh-database migration proves a migration is correct on an empty table
# and nothing about how it behaves on a corpus-sized one. This script starts
# from the schema the promoted release actually serves (its published API
# image applies it), fills the registered high-volume tables with
# scale-shaped rows, then runs this checkout's migrate entrypoint, schema
# migrations and online phase alike, under a wall-clock budget. It runs the
# entrypoint a second time to prove the upgrade is a fixed point, and checks
# that the migrated schema matches schema.ts.
#
# Inputs (environment):
#   DATABASE_URL                       an EMPTY database (refused otherwise);
#                                      every row written to it is disposable
#   REHEARSAL_BASE_REF                 stable tag to upgrade from (vX.Y.Z);
#                                      default: the version production
#                                      reports, else the newest stable tag
#   REHEARSAL_BASE_IMAGE_REPOSITORY    default ghcr.io/stella/stella-api
#   REHEARSAL_BASE_DATABASE_URL        DATABASE_URL as seen from inside the
#                                      base image's container; default
#                                      DATABASE_URL (Linux host network)
#   REHEARSAL_PRODUCTION_READY_URL     default https://api.stll.app/ready
#   REHEARSAL_DECISIONS                decisions to seed; the other tables
#                                      are fixed multiples (see
#                                      apps/api/src/scripts/seed-migration-rehearsal-plan.ts)
#   REHEARSAL_MIGRATE_BUDGET_SECONDS   default 900
#
# Exits non-zero when the database is not empty, the base schema cannot be
# applied, the seed fails, the upgrade fails or outruns its budget, the rerun
# changes the applied migrations, a CHECK constraint's validity, or the rows
# an online repair rewrites, or the schema drifts from schema.ts.
#
# The base image is pulled only when it is not already present, so a caller
# that pulled it with credentials this script never sees (CI does, before it
# drops them) can run without registry access.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
base_ref="${REHEARSAL_BASE_REF:-}"
image_repository="${REHEARSAL_BASE_IMAGE_REPOSITORY:-ghcr.io/stella/stella-api}"
base_database_url="${REHEARSAL_BASE_DATABASE_URL:-$DATABASE_URL}"
ready_url="${REHEARSAL_PRODUCTION_READY_URL:-https://api.stll.app/ready}"
decisions="${REHEARSAL_DECISIONS:-}"
budget="${REHEARSAL_MIGRATE_BUDGET_SECONDS:-900}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stable_tag='^v[0-9]+\.[0-9]+\.[0-9]+$'

log() {
  printf '==> %s\n' "$*"
}

fail() {
  echo "::error::$*" >&2
  exit 1
}

# The promoted release is what an upgrade starts from; production reports
# it. Without that (no network, a fork), the newest stable tag reachable in
# the clone is the best available stand-in, and the summary says which was
# used.
resolve_base_ref() {
  local version
  if [[ -n "$base_ref" ]]; then
    base_source="given"
    return
  fi
  version="$(curl -fsS --max-time 15 "$ready_url" 2>/dev/null | jq -r '.version // empty' 2>/dev/null || true)"
  if [[ -n "$version" ]]; then
    base_ref="v${version}"
    base_source="production ($ready_url)"
    return
  fi
  git -C "$repo_root" fetch --quiet --no-tags origin 'refs/tags/v*:refs/tags/v*' || true
  base_ref="$(git -C "$repo_root" tag --list 'v[0-9]*' --sort=-v:refname | grep -E "$stable_tag" | head -n 1 || true)"
  base_source="newest stable tag (production unreachable)"
}

base_source=""
resolve_base_ref
if [[ ! "$base_ref" =~ $stable_tag ]]; then
  fail "Could not resolve a stable base release to upgrade from (got '${base_ref}')."
fi
base_image="${image_repository}:${base_ref}"

log "Base release: ${base_ref} (${base_source})"
log "Refusing anything but an empty database"
bun "$repo_root/scripts/migration-rehearsal-db.ts" assert-empty

log "Applying the base schema from ${base_image}"
if ! docker image inspect "$base_image" >/dev/null 2>&1; then
  docker pull --quiet "$base_image" >/dev/null
fi
docker run --rm --network host \
  --env "DATABASE_URL=${base_database_url}" \
  "$base_image" \
  bun /app/apps/api/src/db/migrate.js

seed_args=()
if [[ -n "$decisions" ]]; then
  seed_args+=(--decisions "$decisions")
fi
log "Seeding scale-shaped rows"
seed_started="$(date +%s)"
(cd "$repo_root/apps/api" && bun run src/scripts/seed-migration-rehearsal.ts "${seed_args[@]}")
seed_seconds=$(( $(date +%s) - seed_started ))

log "Upgrading to this checkout (budget ${budget}s)"
upgrade_started="$(date +%s)"
if ! (cd "$repo_root/apps/api" && timeout --foreground "$budget" bun run src/db/migrate.ts); then
  upgrade_seconds=$(( $(date +%s) - upgrade_started ))
  if (( upgrade_seconds >= budget )); then
    fail "The upgrade did not finish within ${budget}s on a scale-shaped database."
  fi
  fail "The upgrade failed on a scale-shaped database after ${upgrade_seconds}s."
fi
upgrade_seconds=$(( $(date +%s) - upgrade_started ))

log "Rerunning the upgrade: a completed upgrade must be a fixed point"
state_before="$(bun "$repo_root/scripts/migration-rehearsal-db.ts" digest)"
rerun_started="$(date +%s)"
(cd "$repo_root/apps/api" && timeout --foreground "$budget" bun run src/db/migrate.ts) \
  || fail "Rerunning the migrate entrypoint on an upgraded database failed."
rerun_seconds=$(( $(date +%s) - rerun_started ))
state_after="$(bun "$repo_root/scripts/migration-rehearsal-db.ts" digest)"
if [[ "$state_before" != "$state_after" ]]; then
  printf 'before: %s\nafter:  %s\n' "$state_before" "$state_after"
  fail "Rerunning the migrate entrypoint changed the database: the upgrade is not a fixed point."
fi

log "Checking the migrated schema against schema.ts"
parity_output="$(cd "$repo_root/apps/api" && bun --bun drizzle-kit push --explain 2>&1)" || true
if ! grep -q "No changes detected" <<<"$parity_output"; then
  printf '%s\n' "$parity_output"
  fail "The upgraded schema does not match schema.ts."
fi

{
  echo "### Migration upgrade rehearsal"
  echo
  echo "| Step | Result |"
  echo "| --- | --- |"
  echo "| Base release | \`${base_ref}\` (${base_source}) |"
  echo "| Seed | ${seed_seconds}s |"
  echo "| Upgrade | ${upgrade_seconds}s of ${budget}s |"
  echo "| Rerun | ${rerun_seconds}s, state unchanged |"
  echo "| Schema parity | no changes detected |"
} | tee -a "$summary"
