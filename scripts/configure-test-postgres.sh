#!/usr/bin/env bash
# Configure an already initialized, disposable test container without host binds.
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
container=${1:?Postgres container ID required}
owner=${2:?Database owner login required}
database=${3:-stella}
docker_host=${4:-}
if [[ -z "$docker_host" ]]; then
  # Capture bytes before Bash can discard NUL or trailing newlines.
  docker_bytes=$(command docker context inspect --format '{{.Endpoints.docker.Host}}' | LC_ALL=C od -An -v -t x1)
  encoded_endpoint=""
  for byte in $docker_bytes; do
    case "$byte" in
      00|0d) echo 'Docker context returned an ambiguous endpoint.' >&2; exit 1 ;;
      [0-9a-f][0-9a-f]) encoded_endpoint+="\\x$byte" ;;
      *) echo 'Docker endpoint byte capture failed.' >&2; exit 1 ;;
    esac
  done
  printf -v docker_host '%b' "$encoded_endpoint"
  docker_host=${docker_host%$'\n'}
fi
if [[ "$docker_host" =~ ^[[:space:]]|[[:space:]]$ || "$docker_host" == *$'\r'* || "$docker_host" == *$'\n'* ]]; then
  echo 'Docker context returned an ambiguous endpoint.' >&2
  exit 1
fi
case "$docker_host" in
  unix:///*|tcp://*|ssh://*|npipe://*) ;;
  *) echo 'Docker context did not resolve a supported endpoint.' >&2; exit 1 ;;
esac
if command -v docker-keeper >/dev/null 2>&1; then
  docker-keeper --purpose dev --host "$docker_host" >/dev/null
elif [[ "$docker_host" == unix:///* && "$docker_host" == */.colima/* ]]; then
  echo 'A keeper resolver is required to validate this Colima development endpoint.' >&2
  exit 1
fi
unset DOCKER_HOST DOCKER_CONTEXT
docker() { command docker --host "$docker_host" "$@"; }

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
      printf "SELECT \047%s\047 WHERE (SELECT setting FROM pg_settings WHERE name = \047%s\047) IS DISTINCT FROM \047%s\047;\n", name, name, value
    }
  ' "$repo/docker/postgres/prod-parity.conf" |
    docker exec -i "$container" psql -U "$owner" -d "$database" -v ON_ERROR_STOP=1 -tA
}

mismatches=$(parity_mismatches)
if [[ -n "$mismatches" ]]; then
  # Configure only on drift; healthy development stacks keep their connections.
  docker exec "$container" mkdir -p /etc/postgresql
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
# Bootstrap once, or repair an existing owner without resetting its database.
# A previously configured stack may still have the old LOGIN bootstrap role.
bootstrap_login=$(docker exec "$container" psql -U "$owner" -d "$database" -tAc "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'stella_bootstrap'")
posture=$(docker exec "$container" psql -U "$owner" -d "$database" -tAc "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")
instrumentation_schema=$(docker exec "$container" psql -U "$owner" -d "$database" -tAc "SELECT coalesce((SELECT extnamespace::regnamespace::text FROM pg_extension WHERE extname = 'pg_stat_statements'), 'missing') WHERE EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_stat_statements')")
if [[ "$posture" == t\|* ]]; then
  docker exec -i "$container" psql -U "$owner" -d "$database" -v ON_ERROR_STOP=1 -v "owner=$owner" < "$repo/docker/postgres/init.sql"
elif [[ "$bootstrap_login" == t ]]; then
  # Cut over the concrete older container state before accepting a healthy owner.
  docker exec -i "$container" psql -U stella_bootstrap -d "$database" -v ON_ERROR_STOP=1 -v "owner=$owner" < "$repo/docker/postgres/init.sql"
elif [[ "$posture" == 'f|t' || ( "$posture" == 'f|f' && -n "$instrumentation_schema" && "$instrumentation_schema" != stella_instrumentation ) ]]; then
  { printf 'SET ROLE stella_bootstrap;\n'; cat "$repo/docker/postgres/init.sql"; } |
    docker exec -i --user postgres "$container" psql -U stella_maintenance -d "$database" -v ON_ERROR_STOP=1 -v "owner=$owner"
elif [[ "$posture" != 'f|f' ]]; then
  echo 'Test Postgres owner posture is missing.' >&2; exit 1
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
