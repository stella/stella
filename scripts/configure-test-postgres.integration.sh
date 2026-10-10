#!/usr/bin/env bash
# Exercise the real helper against a disposable workflow service database.
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
container=${1:?Postgres container ID required}
owner=${2:?Database owner login required}
database=${3:-stella}
probe="parity_helper_probe_${RANDOM}_${RANDOM}"
role="stella_parity_probe_${RANDOM}_${RANDOM}"

psql_probe() {
  docker exec -i "$container" psql -U "$owner" -d "$database" -v ON_ERROR_STOP=1 -tA "$@"
}
cleanup() {
  psql_probe -c "DROP TABLE IF EXISTS $probe; DROP FUNCTION IF EXISTS ${probe}_function(); DROP ROLE IF EXISTS $role" >/dev/null
}
trap cleanup EXIT

# Start before configuration so OID 10 and existing user objects reach the
# bootstrap replacement path, rather than only testing its healthy replay.
[[ "$(psql_probe -c "SELECT oid = 10 FROM pg_roles WHERE rolname = current_user")" == t ]] || {
  echo 'Expected the immutable initdb owner before configuration.' >&2; exit 1;
}
psql_probe -c "CREATE TABLE $probe (payload text); INSERT INTO $probe VALUES ('preserved on replay');
CREATE FUNCTION ${probe}_function() RETURNS text LANGUAGE sql AS 'SELECT ''preserved function''::text';
ALTER TABLE $probe ENABLE ROW LEVEL SECURITY; ALTER TABLE $probe FORCE ROW LEVEL SECURITY;
CREATE POLICY read_probe ON $probe FOR SELECT USING (true);
CREATE ROLE $role NOLOGIN; GRANT $role TO \"$owner\" WITH ADMIN TRUE, INHERIT FALSE, SET TRUE" >/dev/null
bash "$repo/scripts/configure-test-postgres.sh" "$container" "$owner" "$database"
[[ "$(psql_probe -c "SELECT relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) FROM pg_class WHERE oid = '$probe'::regclass")" == t ]] || {
  echo 'Existing table ownership was not transferred.' >&2; exit 1;
}
[[ "$(psql_probe -c "SELECT proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) FROM pg_proc WHERE oid = '${probe}_function()'::regprocedure")" == t ]] || {
  echo 'Existing function ownership was not transferred.' >&2; exit 1;
}
[[ "$(psql_probe -c "SELECT ${probe}_function()")" == 'preserved function' ]] || exit 1
if psql_probe -c "INSERT INTO $probe VALUES ('must be denied')" >/dev/null 2>&1; then
  echo 'The replacement owner bypassed FORCE RLS.' >&2; exit 1;
fi
[[ "$(psql_probe -c "SELECT admin_option AND NOT inherit_option AND set_option FROM pg_auth_members WHERE roleid = (SELECT oid FROM pg_roles WHERE rolname = '$role') AND member = (SELECT oid FROM pg_roles WHERE rolname = current_user)")" == t ]] || {
  echo 'Existing application-role grant options were not preserved.' >&2; exit 1;
}
# Exercise password authentication, not the trusted maintenance socket.
docker exec "$container" sh -ec 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -h 127.0.0.1 -U "$1" -d "$2" -v ON_ERROR_STOP=1 -c "SELECT 1"' sh "$owner" "$database" >/dev/null
if docker exec "$container" psql -h 127.0.0.1 -U stella_bootstrap -d "$database" -w -c 'SELECT 1' >/dev/null 2>&1; then
  echo 'The bootstrap account authenticated over TCP.' >&2; exit 1;
fi
[[ "$(psql_probe -c "SELECT NOT pg_has_role(current_user, 'stella_bootstrap', 'MEMBER') AND pg_has_role(current_user, 'pg_read_all_settings', 'USAGE') AND pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AND NOT pg_has_role(current_user, 'pg_monitor', 'MEMBER')")" == t ]] || {
  echo 'The replacement owner has unexpected role privileges.' >&2; exit 1;
}

# Verify the fixture reaches the bug: SHOW/current_setting formats units,
# whereas the fragment and pg_settings.setting use the parameter's raw unit.
formatted=$(psql_probe -c "SELECT current_setting('work_mem')")
raw=$(psql_probe -c "SELECT setting FROM pg_settings WHERE name = 'work_mem'")
[[ "$formatted" != "$raw" ]] || { echo 'Unit formatting fixture did not reach the comparison boundary.' >&2; exit 1; }
[[ "$raw" == 8192 ]] || { echo 'Unexpected work_mem fixture.' >&2; exit 1; }
for setting in statement_timeout idle_in_transaction_session_timeout checkpoint_timeout max_wal_size; do
  mismatch=$(psql_probe -c "SELECT current_setting('$setting') IS DISTINCT FROM setting FROM pg_settings WHERE name = '$setting'")
  [[ "$mismatch" == t ]] || { echo "Expected a unit-bearing value for $setting." >&2; exit 1; }
done

started=$(docker inspect --format '{{.State.StartedAt}}' "$container")
for replay in 1 2; do
  bash "$repo/scripts/configure-test-postgres.sh" "$container" "$owner" "$database"
  [[ "$(docker inspect --format '{{.State.StartedAt}}' "$container")" == "$started" ]] || {
    echo "Replay $replay restarted an already configured Postgres." >&2; exit 1;
  }
  [[ "$(psql_probe -c "SELECT payload FROM $probe")" == 'preserved on replay' ]] || {
    echo "Replay $replay changed existing data." >&2; exit 1;
  }
done
printf 'PASS: raw unit settings match and helper replay preserves the running database.\n'
