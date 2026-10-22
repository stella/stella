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
#                                      default: the latest production promotion
#                                      in the committed release record
#   REHEARSAL_BASE_IMAGE_REPOSITORY    default ghcr.io/stella/stella-api
#   REHEARSAL_BASE_DATABASE_URL        DATABASE_URL as seen from inside the
#                                      base image's container; default
#                                      DATABASE_URL (Linux host network)
#   REHEARSAL_DECISIONS                decisions to seed; the other tables
#                                      are fixed multiples (see
#                                      apps/api/src/scripts/seed-migration-rehearsal-plan.ts)
#   REHEARSAL_MIGRATE_BUDGET_SECONDS   default 900
#   REHEARSAL_WRITER_GAP_BUDGET_SECONDS
#                                      longest a contending writer session
#                                      may go without a commit during the
#                                      upgrade and rerun; default 60
#
# The upgrade and the rerun run against a writer that keeps short
# transactions open on the corpus tables, the way production's ingestion and
# projection workers do: DDL that needs ACCESS EXCLUSIVE on those tables has
# to win a gap between writer transactions, and a single short lock wait does
# not. The writer records every commit, and the upgrade fails when any of its
# sessions went longer than the writer gap budget without one: an upgrade
# that keeps corpus writers out for minutes stalls production's workers for
# minutes even when it finishes within its own budget. Exits non-zero when
# the database is not empty, the base schema cannot be applied, the seed
# fails, the upgrade fails or outruns its budget, corpus writers were kept
# out for longer than the writer gap budget, the rerun changes the applied migrations, a CHECK constraint's validity, or the
# rows an online repair rewrites, or the schema drifts from schema.ts.
#
# The base image is pulled only when it is not already present, so a caller
# that pulled it with credentials this script never sees (CI does, before it
# drops them) can run without registry access.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
base_ref="${REHEARSAL_BASE_REF:-}"
image_repository="${REHEARSAL_BASE_IMAGE_REPOSITORY:-ghcr.io/stella/stella-api}"
base_database_url="${REHEARSAL_BASE_DATABASE_URL:-$DATABASE_URL}"
decisions="${REHEARSAL_DECISIONS:-}"
budget="${REHEARSAL_MIGRATE_BUDGET_SECONDS:-900}"
writer_gap_budget="${REHEARSAL_WRITER_GAP_BUDGET_SECONDS:-60}"
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

# Epoch milliseconds on the clock the contender stamps its commits with.
now_ms() {
  bun -e 'console.log(Date.now())'
}

resolve_base_ref() {
  if [[ -n "$base_ref" ]]; then
    base_source="given"
    return
  fi
  base_ref="$(bun --preload "$repo_root/scripts/offline-network-preload.ts" "$repo_root/scripts/resolve-promoted-release.ts" --check)"
  base_source="committed release publication manifest"
}

base_source=""
resolve_base_ref
if [[ ! "$base_ref" =~ $stable_tag ]]; then
  fail "Could not resolve a stable base release to upgrade from (got '${base_ref}')."
fi
base_image="${image_repository}:${base_ref}"
checkout_image="stella-api-migration-rehearsal:${GITHUB_SHA:-local}"
repair_report="$(mktemp)"
content_encryption_key="$(openssl rand -hex 32)"

api_env=(
  --env "DATABASE_URL=${base_database_url}"
  --env "BETTER_AUTH_SECRET=migration-rehearsal-secret-at-least-32-characters"
  --env "BETTER_AUTH_URL=http://127.0.0.1:3001"
  --env "CONTENT_ENCRYPTION_KEY=${content_encryption_key}"
  --env "EMAIL_PROVIDER=smtp"
  --env "FRONTEND_URL=http://127.0.0.1:3000"
  --env "GOTENBERG_PASSWORD=migration-rehearsal"
  --env "GOTENBERG_URL=http://127.0.0.1:3000"
  --env "GOTENBERG_USERNAME=migration-rehearsal"
  --env "REDIS_URL=redis://127.0.0.1:6379"
  --env "S3_BUCKET=stella"
  --env "S3_CREDENTIALS_PROVIDER=none"
  --env "S3_ENDPOINT=http://127.0.0.1:9000"
  --env "S3_REGION=us-east-1"
  --env "SMTP_HOST=127.0.0.1"
  --env "SMTP_PORT=1025"
  --env "TRANSACTIONAL_EMAIL_FROM=noreply@example.com"
)

boot_until_ready() {
  local image="$1"
  local name="$2"
  local log_file
  log_file="$(mktemp)"
  docker run --rm -d --name "$name" --network host "${api_env[@]}" "$image" > /dev/null
  for _ in $(seq 1 120); do
    if curl --connect-timeout 2 --max-time 5 -fsS http://127.0.0.1:3001/ready >/dev/null; then
      docker stop --time 10 "$name" >/dev/null
      rm -f "$log_file"
      return
    fi
    if ! docker inspect "$name" >/dev/null 2>&1; then
      docker logs "$name" >"$log_file" 2>&1 || true
      cat "$log_file"
      rm -f "$log_file"
      fail "API image ${image} exited before /ready answered."
    fi
    sleep 1
  done
  docker logs "$name" >"$log_file" 2>&1 || true
  cat "$log_file"
  docker stop --time 10 "$name" >/dev/null 2>&1 || true
  rm -f "$log_file"
  fail "API image ${image} did not answer /ready within 120s."
}

log "Base release: ${base_ref} (${base_source})"
log "Refusing anything but an empty database"
bun "$repo_root/scripts/migration-rehearsal-db.ts" assert-empty

log "Applying the base schema from ${base_image}"
if ! docker image inspect "$base_image" >/dev/null 2>&1; then
  bash "$repo_root/scripts/retry.sh" docker pull --quiet "$base_image"
fi
docker run --rm --network host \
  --env "DATABASE_URL=${base_database_url}" \
  --env DB_LOAD_GATE_EBS_SIGNAL --env DB_LOAD_GATE_BUSY_WINDOWS \
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

log "Booting the running base release once"
boot_until_ready "$base_image" stella-rehearsal-base-api

log "Building this checkout's API image"
docker build --quiet --tag "$checkout_image" --file "$repo_root/apps/api/Dockerfile" "$repo_root" >/dev/null

# The writer must hold its locks before the upgrade starts, and must still
# be running when it ends: an upgrade that ran without contention proves
# nothing about lock waits.
log "Starting the contending writer"
contender_log="$(mktemp)"
bun "$repo_root/scripts/migration-rehearsal-db.ts" contend >"$contender_log" 2>&1 &
contender_pid=$!
stop_contender() {
  if kill -0 "$contender_pid" 2>/dev/null; then
    kill "$contender_pid" 2>/dev/null || true
    wait "$contender_pid" 2>/dev/null || true
  fi
}
trap 'stop_contender; docker rm -f stella-rehearsal-base-api stella-rehearsal-checkout-api >/dev/null 2>&1 || true; rm -f "$contender_log" "$repair_report"' EXIT
assert_contender_alive() {
  if ! kill -0 "$contender_pid" 2>/dev/null; then
    cat "$contender_log"
    fail "The contending writer exited: $1"
  fi
}
for _ in $(seq 1 120); do
  if grep -q "contending: locks held" "$contender_log"; then
    break
  fi
  assert_contender_alive "before it held its locks."
  sleep 0.5
done
grep -q "contending: locks held" "$contender_log" \
  || fail "The contending writer did not report holding its locks within 60s."

log "Upgrading to this checkout (budget ${budget}s)"
window_started_ms="$(now_ms)"
upgrade_started="$(date +%s)"
if ! (cd "$repo_root/apps/api" && timeout --foreground "$budget" bun run src/db/migrate.ts --rehearsal-online-repair-report "$repair_report"); then
  upgrade_seconds=$(( $(date +%s) - upgrade_started ))
  if (( upgrade_seconds >= budget )); then
    fail "The upgrade did not finish within ${budget}s on a scale-shaped database."
  fi
  fail "The upgrade failed on a scale-shaped database after ${upgrade_seconds}s."
fi
upgrade_seconds=$(( $(date +%s) - upgrade_started ))

log "Booting this checkout after the upgrade"
boot_until_ready "$checkout_image" stella-rehearsal-checkout-api

log "Checking every online repair met non-empty input"
(cd "$repo_root/apps/api" && bun run src/scripts/assert-online-migration-rehearsal.ts "$repair_report")

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
assert_contender_alive "during the upgrade, so part of it ran without contention."
window_ended_ms="$(now_ms)"
stop_contender

log "Checking how long corpus writers were kept out (budget ${writer_gap_budget}s)"
writer_gap="$(bun "$repo_root/scripts/migration-rehearsal-writer-gap.ts" \
  "$contender_log" "$window_started_ms" "$window_ended_ms" "$writer_gap_budget")" \
  || fail "Corpus writers were kept out for longer than ${writer_gap_budget}s during the upgrade (see the error above)."

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
  echo "| Upgrade | ${upgrade_seconds}s of ${budget}s, against a contending writer |"
  echo "| Rerun | ${rerun_seconds}s, state unchanged |"
  echo "| Writer max gap | ${writer_gap} |"
  echo "| Schema parity | no changes detected |"
} | tee -a "$summary"
