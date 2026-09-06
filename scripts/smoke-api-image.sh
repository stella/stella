#!/usr/bin/env bash
set -euo pipefail

# Disposable release-artifact rehearsal. Never reads repository .env files.
if [[ $# != 1 && $# != 3 ]] || [[ -z "$1" || "$1" == -* ]]; then
  echo "Usage: bash scripts/smoke-api-image.sh <local-image-reference> [--subnet <IPv4-CIDR>]" >&2
  exit 2
fi
image_ref=$1
network_args=(--internal)
if [[ $# == 3 ]]; then
  if [[ "$2" != --subnet || ! "$3" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/(3[0-2]|[12]?[0-9])$ ]]; then
    echo "Expected --subnet followed by an IPv4 CIDR." >&2
    exit 2
  fi
  for octet in "${BASH_REMATCH[@]:1:4}"; do
    if (( 10#$octet > 255 )); then
      echo "Subnet IPv4 octets must be between 0 and 255." >&2
      exit 2
    fi
  done
  network_args+=(--subnet "$3")
fi
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image_id=$(docker image inspect --format '{{.Id}}' "$image_ref")
run_id="stella-startup-$(openssl rand -hex 8)"
network="$run_id-net"
postgres="$run_id-postgres"
redis="$run_id-redis"
api="$run_id-api"
probe="$run_id-probe"
owner_label=stella.release-smoke.owner
network_created=false
cleanup() {
  status=$?
  trap - EXIT INT TERM
  for name in "$probe" "$api" "$redis" "$postgres"; do
    if [[ "$(docker inspect --format '{{ index .Config.Labels "stella.release-smoke.owner" }}' "$name" 2>/dev/null || true)" == "$run_id" ]]; then
      if [[ "$status" != 0 ]]; then
        docker logs --tail 30 "$name" 2>&1 || true
      fi
      if ! docker rm --force --volumes "$name" >/dev/null; then
        printf 'Failed to remove smoke container %s\n' "$name" >&2
        status=1
      fi
    fi
  done
  if [[ "$network_created" == true && "$(docker network inspect --format '{{ index .Labels "stella.release-smoke.owner" }}' "$network" 2>/dev/null || true)" == "$run_id" ]]; then
    if ! docker network rm "$network" >/dev/null; then
      printf 'Failed to remove smoke network %s\n' "$network" >&2
      status=1
    fi
  fi
  printf 'Smoke cleanup finished (exit %s). Cleanup targets only this run\047s disposable resources.\n' "$status"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Internal bridge: no production access and no host ports or host networking.
# Optional local escape hatch for a Docker daemon with exhausted default pools.
docker network create "${network_args[@]}" --label "$owner_label=$run_id" "$network" >/dev/null
network_created=true
docker run --detach --name "$postgres" --network "$network" --network-alias smoke-postgres \
  --tmpfs /var/lib/postgresql:rw,size=1g \
  --label "$owner_label=$run_id" \
  --env POSTGRES_USER=postgres --env POSTGRES_PASSWORD=smoke-only --env POSTGRES_DB=stella \
  postgres:18.6@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280 >/dev/null
docker run --detach --name "$redis" --network "container:$postgres" \
  --label "$owner_label=$run_id" \
  redis:8@sha256:298e5b3bc566bade82f46ad5511777a4a07a294097ce16ada2f6a42be5239df5 >/dev/null
ready=false
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec "$postgres" pg_isready -h 127.0.0.1 -U postgres -d stella >/dev/null 2>&1 \
    && [[ "$(docker exec "$redis" redis-cli ping 2>/dev/null || true)" == PONG ]]; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]] || { echo 'Disposable database/cache did not become ready.' >&2; exit 1; }

psql_smoke() {
  docker exec -i "$postgres" psql -U postgres -d stella -v ON_ERROR_STOP=1 "$@"
}
run_probe() {
  docker run --rm --name "$probe" --label "$owner_label=$run_id" --network "$network" "$@"
}
migrate() {
  run_probe --env DATABASE_URL=postgres://postgres:smoke-only@smoke-postgres:5432/stella \
    "$image_id" bun /app/apps/api/src/db/migrate.js
}

printf 'Testing immutable local image %s (%s)\n' "$image_ref" "$image_id"
psql_smoke < "$repo/docker/postgres/init.sql"
migrate
echo 'PASS: fresh database migrations'
psql_smoke -c 'CREATE TABLE drizzle.__migration_history_smoke_backup AS SELECT id, hash FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1' >/dev/null
[[ "$(psql_smoke -tAc 'SELECT count(*) FROM drizzle.__migration_history_smoke_backup')" == 1 ]]
[[ "$(psql_smoke -tAc "WITH corrupted AS (UPDATE drizzle.__drizzle_migrations AS migration SET hash = repeat('0', 64) FROM drizzle.__migration_history_smoke_backup AS backup WHERE migration.id = backup.id RETURNING 1) SELECT count(*) FROM corrupted")" == 1 ]]
migration_exit=0
migrate || migration_exit=$?
[[ "$(psql_smoke -tAc "WITH restored AS (UPDATE drizzle.__drizzle_migrations AS migration SET hash = backup.hash FROM drizzle.__migration_history_smoke_backup AS backup WHERE migration.id = backup.id AND migration.hash = repeat('0', 64) RETURNING 1) SELECT count(*) FROM restored")" == 1 ]]
psql_smoke -c 'DROP TABLE drizzle.__migration_history_smoke_backup' >/dev/null
[[ "$migration_exit" != 0 ]] || { echo 'Migration accepted corrupted history.' >&2; exit 1; }
migrate
echo 'PASS: corrupt history rejected and restored history accepted'

docker run --detach --name "$api" --label "$owner_label=$run_id" --network "container:$postgres" \
  --env BETTER_AUTH_SECRET=release-smoke-secret-at-least-32-chars \
  --env BETTER_AUTH_URL=http://localhost:3001 \
  --env "CONTENT_ENCRYPTION_KEY=$(openssl rand -hex 32)" \
  --env DATABASE_URL=postgres://postgres:smoke-only@127.0.0.1:5432/stella \
  --env EMAIL_PROVIDER=smtp --env FRONTEND_URL=http://localhost:3000 \
  --env GOOGLE_GENERATIVE_AI_API_KEY=release-smoke \
  --env GOTENBERG_PASSWORD=smoke --env GOTENBERG_URL=http://127.0.0.1:3000 --env GOTENBERG_USERNAME=smoke \
  --env POSTHOG_HOST=http://127.0.0.1:9999 --env POSTHOG_KEY=phc_ \
  --env REDIS_URL=redis://127.0.0.1:6379 \
  --env S3_BUCKET=stella-smoke --env S3_ENDPOINT=http://127.0.0.1:9000 --env S3_REGION=us-east-1 \
  --env SMTP_HOST=127.0.0.1 --env SMTP_PORT=1025 \
  --env TRANSACTIONAL_EMAIL_FROM=noreply@example.invalid --env USE_MOCK_AI=false \
  "$image_id" >/dev/null
ready=false
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec "$api" bun -e 'const r = await fetch("http://127.0.0.1:3001/live"); process.exit(r.ok ? 0 : 1)' >/dev/null 2>&1 \
    && docker logs "$api" 2>&1 | grep -F '"message":"scheduler.started"' >/dev/null; then
    ready=true
    break
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "$api")" != true ]]; then
    break
  fi
  sleep 2
done
if [[ "$ready" != true ]]; then
  docker logs "$api"
  echo 'API did not reach /live plus scheduler.started.' >&2
  exit 1
fi
echo 'PASS: API /live and scheduler.started'

output=$(run_probe "$image_id" timeout 20 /app/collab 2>&1 || true)
if grep -qiE 'cannot (find|resolve) (module|package)' <<< "$output" \
  || ! grep -q 'Invalid environment variables' <<< "$output"; then
  printf 'FAIL: collab did not reach environment validation\n%s\n' "$output" >&2
  exit 1
fi
echo 'PASS: collab reached environment validation'

for entrypoint in /app/document-processing-worker.js /app/backfill.js; do
  output=$(run_probe "$image_id" timeout 20 bun "$entrypoint" 2>&1 || true)
  if grep -qiE 'cannot (find|resolve) (module|package)' <<< "$output" \
    || ! grep -q 'Invalid environment variables' <<< "$output"; then
    printf 'FAIL: %s did not reach environment validation\n%s\n' "$entrypoint" "$output" >&2
    exit 1
  fi
  printf 'PASS: %s reached environment validation\n' "$entrypoint"
done
for entrypoint in /app/better-auth-migration-audit.js /app/better-auth-microsoft-identity-map.js /app/better-auth-17-backfill.js /app/database-census.js /app/better-auth-sign-in-replay.js; do
  output=$(run_probe "$image_id" timeout 20 bun "$entrypoint" 2>&1 || true)
  if grep -qiE 'cannot (find|resolve) (module|package)' <<< "$output" \
    || ! grep -q '"code":"invalid-arguments"' <<< "$output"; then
    printf 'FAIL: %s did not reach command validation\n%s\n' "$entrypoint" "$output" >&2
    exit 1
  fi
  printf 'PASS: %s reached command validation\n' "$entrypoint"
done
run_probe "$image_id" timeout 20 bun /app/legal-atlas.js list
echo 'PASS: legal-atlas list'
run_probe "$image_id" test -f /tmp/image-smoke-ok
echo 'PASS: final image carries runtime-asset-smoke success marker'
echo 'PASS: full local release smoke'
