#!/usr/bin/env bash
set -eo pipefail
armed_delta=false
if [[ "${NORMAL_REUSED:-}" == true && "${SUITE_DEPTH:-}" == fast && "${ROUTE_SMOKE_REQUIRED:-}" != true && "${MARKETING_REQUIRED:-}" != true ]]; then
  armed_delta=true
  RUN_REQUIRED=false
fi
heavy_proof=false
if [[ "${RUN_REQUIRED:-true}" != false || "$armed_delta" == true ]]; then
  case "$EVENT_NAME" in
    pull_request) [[ "${ARMED:-false}" != true ]] || heavy_proof=true ;;
    merge_group)
      heavy_proof=true
      # The exact bound source payloads must cover every suite this
      # group now requires; missing planner inputs retain all suites.
      if [[ "${ARMED_PROOF:-}" == complete ]] && jq -ne \
        --argjson scopes "$ARMED_JOB_SCOPES" --slurpfile plans "$CHANGED_SCOPE_PATH" --argjson eligible "$HEAVY_PROOF_JOBS" \
        --argjson proven "$ARMED_PROOF_JOBS" --argjson keep "$MERGE_GROUP_HEAVY_KEEP" \
        --arg marketing "${MARKETING_REQUIRED:-false}" '
          ($plans[0] + {marketing_screenshots_required: $marketing}) as $planned
          | ($scopes | type == "object" and length > 0)
          and (($scopes | keys) == ($eligible | sort))
          and all($scopes[]; if . == null then true
            elif type == "string" then . as $scope | ($planned[$scope] == "true" or $planned[$scope] == "false")
            else false end)
          and ($proven | type == "array" and all(.[]; type == "string"))
          and all($scopes | to_entries[];
            (.key as $job | $keep | index($job)) != null
            or (.value != null and $planned[.value] == "false")
            or (.key as $job | $proven | index($job)) != null)' > /dev/null; then
        heavy_proof=false
      fi
      ;;
    *) heavy_proof=true ;;
  esac
fi
{
  echo "run_required=$RUN_REQUIRED"
  echo "armed_delta=$armed_delta"
  echo "heavy_proof=$heavy_proof"
} >> "$GITHUB_OUTPUT"
