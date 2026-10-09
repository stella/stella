#!/usr/bin/env bash
# Exercise the real helper against a disposable workflow service database.
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
container=${1:?Postgres container ID required}
owner=${2:?Database owner login required}
database=${3:-stella}
probe="parity_helper_probe_${RANDOM}_${RANDOM}"

psql_probe() {
  docker exec -i "$container" psql -U "$owner" -d "$database" -v ON_ERROR_STOP=1 -tA "$@"
}
cleanup() {
  psql_probe -c "DROP TABLE IF EXISTS $probe" >/dev/null
}
trap cleanup EXIT

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

psql_probe -c "CREATE TABLE $probe (payload text); INSERT INTO $probe VALUES ('preserved on replay')" >/dev/null
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
