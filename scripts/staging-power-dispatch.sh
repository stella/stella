#!/usr/bin/env bash
# Runs one Staging Power action (status or on) in the infrastructure
# repository, waits for it, and prints whether the staging runtime is up:
#
#   runtime=up    the API service is scaled up (running, starting, or failing
#                 to start); a deploy can replace what it runs
#   runtime=off   the API service is scaled to zero
#
# The infrastructure workflow names a run "Staging power <action>[ (Nh)] for
# <caller>" and reports the runtime through the conclusion of its "Staging
# runtime is up" step (success or skipped). Both are its contract with this
# script; anything else fails closed.
#
# Environment:
#   GH_TOKEN         App installation token with actions:write on INFRA_REPO
#   GH_RETRY_SCRIPT  scripts/gh-retry.sh
#   INFRA_REPO       owner/name of the infrastructure repository
#   CALLER           unique id of this caller run (letters, digits, . _ -)
#   HOURS            lease hours for "on": 1, 2, 4 or 8 (default 2)
set -euo pipefail

readonly WORKFLOW_FILE="staging-power.yml"
readonly RUNTIME_STEP="Staging runtime is up"
readonly POLL_SECONDS="${STAGING_POWER_POLL_SECONDS:-10}"
readonly FIND_ATTEMPTS="${STAGING_POWER_FIND_ATTEMPTS:-30}"
readonly WATCH_ATTEMPTS="${STAGING_POWER_WATCH_ATTEMPTS:-150}"

action="${1:-}"
case "$action" in
  status | on) ;;
  *)
    echo "::error::usage: staging-power-dispatch.sh <status|on>" >&2
    exit 2
    ;;
esac
if [[ ! "${INFRA_REPO:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "::error::INFRA_REPO must be an owner/name pair." >&2
  exit 2
fi
if [[ ! "${CALLER:-}" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then
  echo "::error::CALLER must be 1-64 letters, digits, dots, dashes or underscores." >&2
  exit 2
fi
hours="${HOURS:-2}"
case "$hours" in
  1 | 2 | 4 | 8) ;;
  *)
    echo "::error::HOURS must be 1, 2, 4 or 8." >&2
    exit 2
    ;;
esac

title="Staging power ${action}"
if [[ "$action" == "on" ]]; then
  title+=" (${hours}h)"
fi
title+=" for ${CALLER}"

# deploy_main=false: the caller deploys its own commit, so the start must not
# dispatch a second deploy of main.
bash "$GH_RETRY_SCRIPT" api --method POST \
  "repos/${INFRA_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches" \
  -f "ref=main" \
  -f "inputs[action]=${action}" \
  -f "inputs[hours]=${hours}" \
  -f "inputs[deploy_main]=false" \
  -f "inputs[caller]=${CALLER}" >/dev/null
echo "Dispatched ${WORKFLOW_FILE} (${title}) on ${INFRA_REPO}." >&2

# The title carries this caller's unique id, so it identifies the run alone.
run_id=""
for ((attempt = 1; attempt <= FIND_ATTEMPTS; attempt += 1)); do
  run_id="$(
    bash "$GH_RETRY_SCRIPT" api \
      "repos/${INFRA_REPO}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=30" \
      --jq ".workflow_runs[] | select(.display_title == \"${title}\") | .id" |
      head -n 1
  )"
  if [[ -n "$run_id" ]]; then
    break
  fi
  sleep 2
done
if [[ -z "$run_id" ]]; then
  echo "::error::The dispatched staging power run (${title}) did not appear." >&2
  exit 1
fi

run_url="${GITHUB_SERVER_URL:-https://github.com}/${INFRA_REPO}/actions/runs/${run_id}"
echo "Watching ${run_url}" >&2
conclusion=""
for ((attempt = 1; attempt <= WATCH_ATTEMPTS; attempt += 1)); do
  state="$(
    bash "$GH_RETRY_SCRIPT" api "repos/${INFRA_REPO}/actions/runs/${run_id}" \
      --jq '[.status, (.conclusion // "")] | @tsv'
  )"
  if [[ "$(cut -f1 <<<"$state")" == "completed" ]]; then
    conclusion="$(cut -f2 <<<"$state")"
    break
  fi
  sleep "$POLL_SECONDS"
done
if [[ -z "$conclusion" ]]; then
  echo "::error::The staging power run did not finish in time: ${run_url}" >&2
  exit 1
fi
if [[ "$conclusion" != "success" ]]; then
  echo "::error::The staging power run ended ${conclusion}: ${run_url}" >&2
  exit 1
fi

step_conclusion="$(
  bash "$GH_RETRY_SCRIPT" api "repos/${INFRA_REPO}/actions/runs/${run_id}/jobs" \
    --jq "[.jobs[].steps[]? | select(.name == \"${RUNTIME_STEP}\") | .conclusion] | first // \"\""
)"
case "$step_conclusion" in
  success) echo "runtime=up" ;;
  skipped) echo "runtime=off" ;;
  *)
    echo "::error::The staging power run did not report the runtime (step \"${RUNTIME_STEP}\": ${step_conclusion:-missing}): ${run_url}" >&2
    exit 1
    ;;
esac
