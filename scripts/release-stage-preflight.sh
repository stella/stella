#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "::error::$1: $2" >&2
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "reason=$1: $2" >> "$GITHUB_OUTPUT"; fi
  exit 1
}

wait_for_head_group() {
  local tip
  for ((attempt=0; attempt<=120; attempt++)); do
    if [[ -n "${RELEASE_STAGE_DEADLINE:-}" ]] && (($(date +%s)>=RELEASE_STAGE_DEADLINE)); then
      fail release_stage_budget_exhausted "queue check deadline reached before staging"
    fi
    tip=$(bash "$GH_RETRY_SCRIPT" api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq '.object.sha')
    if [[ "$tip" == "$EXPECTED_BASE" ]]; then return 0; fi
    if ((attempt<120)); then sleep 30; fi
  done
  fail group_head_timeout "group did not become the head group in 60 min"
}

# Replace this one probe when the authoritative runner online state is available.
probe_deploy_runner_online() {
  local runners recent_ids='[]' ids
  [[ -n "${REQUIRED_DEPLOY_RUNNER_LABEL:-}" ]] \
    || fail runner_label_unconfigured "the staging deployment runner label is not configured"
  for ((attempt=0; attempt<3; attempt++)); do
    if ! runners=$(bash "$GH_RETRY_SCRIPT" api --paginate "orgs/$GITHUB_REPOSITORY_OWNER/actions/runners?per_page=100"); then
      fail runner_probe_unavailable "required runner availability could not be read"
    fi
    if jq -se --arg label "$REQUIRED_DEPLOY_RUNNER_LABEL" 'any(.[].runners[]; .status == "online" and any(.labels[]; .name == $label))' <<<"$runners" >/dev/null; then return 0; fi
    ids=$(jq -sc --arg label "$REQUIRED_DEPLOY_RUNNER_LABEL" '[.[].runners[] | select(any(.labels[]; .name == $label)) | .id]' <<<"$runners")
    # Only newly appearing registrations prove recent availability; removals do not.
    if ((attempt>0)) && jq -e --argjson previous "$recent_ids" 'any(.[]; . as $id | $previous | index($id) | not)' <<<"$ids" >/dev/null; then return 0; fi
    recent_ids="$ids"
    if ((attempt<2)); then sleep 60; fi
  done
  fail required_runner_offline "no required deployment runner appeared online in the bounded probe"
}

wait_for_powered_staging() {
  local response deadline remaining
  deadline=$(($(date +%s) + 570))
  if [[ -n "${RELEASE_STAGE_DEADLINE:-}" ]] && ((RELEASE_STAGE_DEADLINE<deadline)); then
    deadline=$RELEASE_STAGE_DEADLINE
  fi
  response=$(mktemp)
  for ((attempt=0; attempt<20; attempt++)); do
    if (($(date +%s)>=deadline)); then break; fi
    if curl --fail --silent --show-error --max-time 5 \
      --retry 1 --retry-all-errors --retry-delay 1 --retry-max-time 10 \
      --header "x-stella-edge-token: ${EDGE_TOKEN:-}" \
      https://api-staging.stll.app/ready > "$response" && \
      jq -e '.status == "ok"' "$response" >/dev/null; then
      rm -f "$response"
      return 0
    fi
    remaining=$((deadline - $(date +%s)))
    if ((remaining<=0)); then break; fi
    if ((remaining>30)); then remaining=30; fi
    if ((attempt<19)); then sleep "$remaining"; fi
  done
  rm -f "$response"
  fail staging_power_readiness_timeout "powered staging did not become ready in 10 min"
}

case "${1:-}" in
  head) wait_for_head_group ;;
  runner) probe_deploy_runner_online ;;
  ready) wait_for_powered_staging ;;
  budget)
    remaining=$((RELEASE_STAGE_DEADLINE - $(date +%s)))
    if ((remaining<=0)); then fail release_stage_budget_exhausted "no deployment budget remains"; fi
    echo "polls=$((remaining / 10 + 1))" >> "$GITHUB_OUTPUT"
    ;;
  *) fail invalid_preflight "expected head, runner, ready or budget" ;;
esac
