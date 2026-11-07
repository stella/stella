#!/usr/bin/env bash
# Exercise the exact production image while the candidate still serves staging.
set -euo pipefail
image="$1"
source_path="$2"
contract="$source_path/apps/web/build-env-contract.json"
staging_image="$3"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
for reference in "$image" "$staging_image"; do
  bash scripts/retry.sh docker pull "$reference" >/dev/null
done
docker image inspect "$staging_image" --format '{{index .Config.Labels "app.stella.web-configuration"}}' > "$work/staging.json"
docker image inspect "$image" --format '{{index .Config.Labels "app.stella.web-configuration"}}' > "$work/production.json"
# Compare configuration receipts embedded in the immutable images themselves.
jq -e -n --slurpfile contract "$contract" --slurpfile staging "$work/staging.json" --slurpfile production "$work/production.json" '
  ($contract[0].variables | keys) as $allowed |
  (($staging[0] | keys) + ($production[0] | keys) | unique) as $keys |
  all($keys[]; . as $key | ($staging[0][$key] == $production[0][$key]) or ($allowed | index($key) != null))
' >/dev/null
container="$(docker run -d -p 127.0.0.1::3002 "$image")"
trap 'docker rm -f "$container" >/dev/null' EXIT
port="$(docker port "$container" 3002/tcp | cut -d: -f2)"
trap 'docker rm -f "$container" >/dev/null; rm -rf "$work"' EXIT
# Until the server listens, the published port accepts and then resets the
# connection, which --retry-connrefused does not cover: retry every error, and
# show why the image never answered if it does not.
if ! curl --fail --silent --show-error --max-time 10 --retry 30 --retry-all-errors --retry-delay 2 "http://127.0.0.1:$port/" > "$work/index.html"; then
  docker inspect "$container" --format 'container status={{.State.Status}} exit={{.State.ExitCode}}' >&2
  docker logs --tail 100 "$container" >&2
  exit 1
fi
# Read the image's build inventory rather than assuming HTML links all lazy chunks.
docker cp "$container:/app/apps/web/dist/.stella-client-assets" "$work/assets"
awk '/\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]+\.(js|css)$/ { print; count++; if (count == 3) exit }' "$work/assets" > "$work/probes"
[[ "$(wc -l < "$work/probes" | tr -d ' ')" == 3 ]]
while IFS= read -r asset; do
  docker cp "$container:/app/apps/web/dist/client/$asset" "$work/expected-asset"
  curl --fail --silent --show-error "http://127.0.0.1:$port/$asset" > "$work/served-asset"
  cmp "$work/expected-asset" "$work/served-asset"
done < "$work/probes"
