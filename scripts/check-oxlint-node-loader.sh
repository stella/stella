#!/usr/bin/env bash
# Oxlint's Node shim must load the repository config and its plugins. Treat
# every unsuccessful probe as a loader failure because filtering diagnostics
# can turn a new loader error shape into a false pass.
set -euo pipefail

config=${1:-oxlint.config.ts}
target=${2:-scripts/__fixtures__/oxlint-node-loader-clean.ts}

if probe_output=$(./node_modules/.bin/oxlint -c "$config" "$target" 2>&1); then
  exit 0
else
  status=$?
fi

echo "Oxlint did not load the configuration under Node." >&2
echo "Usual cause: a relative import missing its file extension." >&2
echo "" >&2
echo "$probe_output" >&2
exit "$status"
