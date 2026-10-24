#!/usr/bin/env bash
# Starts staging for a release-candidate deploy that found it off, then waits
# until it answers /ready.
#
# Staging starts through the infra repository's staging-power.yml with
# action=on and a 2 h lease: the lease powers staging off again when it ends,
# and a later "on" only extends it. "off" is never sent: it releases every
# lease, including other people's. The run is found by its run-name, waited
# on until it succeeds, and then /ready is probed until staging serves.
#
# Writes deploy=true or deploy=false to GITHUB_OUTPUT. On a failed or
# timed-out start or readiness it records the staging/verified error on the
# deploy commit, names what failed and exits 1.
#
# Environment:
#   GH_RETRY_SCRIPT       scripts/gh-retry.sh, the GitHub command owner
#   GH_TOKEN              token for this repository's commit status
#   STAGING_POWER_TOKEN   App token for INFRA_REPO with actions: write
#   INFRA_REPO            owner/name of the repository with staging-power.yml
#   DEPLOY_SHA            the commit this run deploys
#   STAGING_HEALTH_URL    readiness endpoint (default: staging /ready)
#   EDGE_HEADER_NAME, EDGE_HEADER_VALUE   optional edge access header
# Bounds (each loop has one; tests shorten them):
#   STAGING_WAKE_LOOKUP_ATTEMPTS          reads until the run appears (30)
#   STAGING_WAKE_LOOKUP_INTERVAL_SECONDS  pause between those reads (2)
#   STAGING_WAKE_START_MINUTES            wait for the start run (15)
#   STAGING_WAKE_START_POLL_SECONDS       pause between run reads (15)
#   STAGING_WAKE_READY_MINUTES            wait for /ready (45)
#   STAGING_WAKE_READY_POLL_SECONDS       pause between probes (30)
set -euo pipefail

readonly power_workflow="staging-power.yml"
readonly lease_hours="2"
# Must match the run-name of staging-power.yml for action=on.
readonly run_title="Staging power on (${lease_hours}h)"

lookup_attempts="${STAGING_WAKE_LOOKUP_ATTEMPTS:-30}"
lookup_interval="${STAGING_WAKE_LOOKUP_INTERVAL_SECONDS:-2}"
start_minutes="${STAGING_WAKE_START_MINUTES:-15}"
start_poll="${STAGING_WAKE_START_POLL_SECONDS:-15}"
ready_minutes="${STAGING_WAKE_READY_MINUTES:-45}"
ready_poll="${STAGING_WAKE_READY_POLL_SECONDS:-30}"
health_url="${STAGING_HEALTH_URL:-https://api-staging.stll.app/ready}"

: "${GH_RETRY_SCRIPT:?GH_RETRY_SCRIPT is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${DEPLOY_SHA:?DEPLOY_SHA is required}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
deploy_run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}/actions/runs/${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"

# Refuses the deploy the way an off staging always has: deploy=false and the
# staging/verified error on the deploy commit, linked to this run.
refuse() {
  local description="$1" message="$2"
  echo "deploy=false" >> "$GITHUB_OUTPUT"
  {
    echo "### Staging did not start"
    printf '%s\n' "$message"
    echo "\`${DEPLOY_SHA}\` was not deployed. Dispatch this workflow again once staging answers."
  } >> "$summary"
  echo "::error::${message} Nothing was deployed: ${deploy_run_url}"
  jq -n --arg url "$deploy_run_url" --arg description "$description" \
    '{state: "error", context: "staging/verified", description: $description, target_url: $url}' |
    bash "$GH_RETRY_SCRIPT" api "repos/${GITHUB_REPOSITORY}/statuses/${DEPLOY_SHA}" \
      --method POST --input - >/dev/null
  exit 1
}

infra_api() {
  GH_TOKEN="$STAGING_POWER_TOKEN" bash "$GH_RETRY_SCRIPT" api "$@"
}

if [[ ! "${INFRA_REPO:-}" =~ ^[^/]+/[^/]+$ ]]; then
  refuse "staging start not configured" "The staging power repository is not configured (got '${INFRA_REPO:-}'); set STAGING_DEPLOY_REPOSITORY."
fi
if [[ -z "${STAGING_POWER_TOKEN:-}" ]]; then
  refuse "staging start failed" "No token for ${INFRA_REPO} could be minted; check the release App installation and its actions permission."
fi

# One probe: ready only on HTTP 200 with status ok.
probe_ready() {
  local response_file http_status="000"
  local -a edge_args=()
  if [[ -n "${EDGE_HEADER_NAME:-}" && -n "${EDGE_HEADER_VALUE:-}" ]]; then
    edge_args+=(--header "${EDGE_HEADER_NAME}: ${EDGE_HEADER_VALUE}")
  fi
  response_file="$(mktemp)"
  if ! http_status="$(
    curl \
      --connect-timeout 5 \
      --max-time 10 \
      --retry 2 \
      --retry-all-errors \
      --retry-max-time 20 \
      --output "$response_file" \
      --silent \
      --show-error \
      --write-out '%{http_code}' \
      ${edge_args[@]+"${edge_args[@]}"} \
      "$health_url"
  )"; then
    http_status="000"
  fi
  if [[ "$http_status" == "200" ]] && jq -e '.status == "ok"' "$response_file" >/dev/null 2>&1; then
    rm -f "$response_file"
    return 0
  fi
  rm -f "$response_file"
  echo "Staging readiness probe returned HTTP ${http_status}."
  return 1
}

dispatched_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Starting staging through ${power_workflow} on ${INFRA_REPO} (action=on, hours=${lease_hours})..."
# A dispatch is never retried: a second "on" would leave two matching runs.
if ! infra_api --method POST "/repos/${INFRA_REPO}/actions/workflows/${power_workflow}/dispatches" \
  -f "ref=main" -f "inputs[action]=on" -f "inputs[hours]=${lease_hours}" >/dev/null; then
  refuse "staging start failed" "Dispatching ${power_workflow} on ${INFRA_REPO} failed."
fi

# The dispatches endpoint answers 204 without a run id; the run is found by
# its exact title among runs created since the dispatch.
run_id=""
for ((attempt = 1; attempt <= lookup_attempts; attempt += 1)); do
  if ! run_ids="$(
    infra_api "/repos/${INFRA_REPO}/actions/workflows/${power_workflow}/runs?event=workflow_dispatch&per_page=20" \
      --jq ".workflow_runs[] | select(.created_at >= \"${dispatched_at}\") | select(.display_title == \"${run_title}\") | .id"
  )"; then
    refuse "staging start failed" "Reading the ${power_workflow} runs on ${INFRA_REPO} failed."
  fi
  matches="$(grep -c . <<<"$run_ids" || true)"
  if ((matches > 1)); then
    refuse "staging start ambiguous" "More than one '${run_title}' run started since ${dispatched_at}; cannot tell which one this dispatch created: https://github.com/${INFRA_REPO}/actions/workflows/${power_workflow}"
  fi
  if ((matches == 1)); then
    run_id="$run_ids"
    break
  fi
  if ((attempt < lookup_attempts)); then
    sleep "$lookup_interval"
  fi
done
if [[ -z "$run_id" ]]; then
  refuse "staging start failed" "The '${run_title}' run did not appear after ${lookup_attempts} reads: https://github.com/${INFRA_REPO}/actions/workflows/${power_workflow}"
fi

power_run_url="https://github.com/${INFRA_REPO}/actions/runs/${run_id}"
echo "Waiting for ${power_run_url} (up to ${start_minutes} minutes)..."
start_deadline=$((SECONDS + start_minutes * 60))
conclusion=""
while true; do
  if ! run_state="$(infra_api "/repos/${INFRA_REPO}/actions/runs/${run_id}" --jq '[.status, (.conclusion // "")] | @tsv')"; then
    refuse "staging start failed" "Reading the staging start run failed: ${power_run_url}"
  fi
  status="$(cut -f1 <<<"$run_state")"
  if [[ "$status" == "completed" ]]; then
    conclusion="$(cut -f2 <<<"$run_state")"
    break
  fi
  if ((SECONDS >= start_deadline)); then
    refuse "staging start timed out" "The staging start run did not finish within ${start_minutes} minutes: ${power_run_url}"
  fi
  sleep "$start_poll"
done
if [[ "$conclusion" != "success" ]]; then
  refuse "staging start failed" "The staging start run concluded '${conclusion}': ${power_run_url}"
fi

echo "Staging start run succeeded; waiting for ${health_url} (up to ${ready_minutes} minutes)..."
ready_deadline=$((SECONDS + ready_minutes * 60))
until probe_ready; do
  if ((SECONDS >= ready_deadline)); then
    refuse "staging not ready within ${ready_minutes} min" "Staging started (${power_run_url}) but was not ready within ${ready_minutes} minutes."
  fi
  sleep "$ready_poll"
done

echo "deploy=true" >> "$GITHUB_OUTPUT"
echo "Staging is ready; it powers off again when its ${lease_hours} h lease ends." | tee -a "$summary"
