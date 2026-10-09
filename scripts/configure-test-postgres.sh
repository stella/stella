#!/usr/bin/env bash
# Configure an already initialized, disposable test container without host binds.
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
container=${1:?Postgres container ID required}
owner=${2:?Database owner login required}
database=${3:-stella}

# Derive the complete expectation from the fragment; there is no second list.
# Only the committed setting syntax (name = scalar) is accepted here.
parity_mismatches() {
  awk -F '=' '
    /^[[:space:]]*(#|$)/ { next }
    {
      name=$1; value=$2
      gsub(/[[:space:]\047]/, "", name)
      gsub(/[[:space:]\047]/, "", value)
      if (name !~ /^[a-z_.]+$/ || value !~ /^[a-z_0-9]+$/ || NF != 2) exit 1
      printf "SELECT \047%s\047 WHERE current_setting(\047%s\047, true) IS DISTINCT FROM \047%s\047;\n", name, name, value
    }
  ' "$repo/docker/postgres/prod-parity.conf" |
    docker exec -i "$container" psql -U "$owner" -d "$database" -v ON_ERROR_STOP=1 -tA
}

mismatches=$(parity_mismatches)
if [[ -n "$mismatches" ]]; then
  # Configure only on drift; healthy development stacks keep their connections.
  docker cp "$repo/docker/postgres/prod-parity.conf" "$container:/etc/postgresql/prod-parity.conf"
  docker exec -i "$container" sh -se <<'SH'
conf="$PGDATA/postgresql.conf"
include="include = '/etc/postgresql/prod-parity.conf'"
if ! grep -Fxq "$include" "$conf"; then
  printf '\n%s\n' "$include" >> "$conf"
fi
SH
  docker restart "$container" >/dev/null
  ready=false
  for ((attempt=0; attempt<60; attempt++)); do
    if docker exec "$container" pg_isready -U "$owner" -d "$database" >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 1
  done
  [[ "$ready" == true ]] || { echo 'Test Postgres did not become ready.' >&2; exit 1; }
fi
# Apply the seed only while the image-created owner is still a superuser.
# Subsequent invocations verify the reduced privilege posture below.
if [[ "$(docker exec "$container" psql -U "$owner" -d "$database" -tAc "SELECT rolsuper FROM pg_roles WHERE rolname = current_user")" == t ]]; then
  docker exec -i "$container" psql -U "$owner" -d "$database" -v ON_ERROR_STOP=1 < "$repo/docker/postgres/init.sql"
fi
# This assertion also runs on migration-only jobs, independently of suite selection.
docker exec -i "$container" psql -U "$owner" -d "$database" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF current_setting('jit') <> 'off' OR pg_jit_available() THEN
    RAISE EXCEPTION 'Test Postgres must run with JIT disabled';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls))
     OR NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = current_database() AND datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION 'Test database must belong to a non-superuser, non-bypassrls owner';
  END IF;
END $$;
SQL

mismatches=$(parity_mismatches)
[[ -z "$mismatches" ]] || { printf 'Postgres parity settings differ: %s\n' "$mismatches" >&2; exit 1; }
