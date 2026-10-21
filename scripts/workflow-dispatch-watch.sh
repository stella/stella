set -euo pipefail

readonly TOKEN_REFRESH_SECONDS=2700
readonly WATCH_POLL_SECONDS=10
readonly WATCH_MAX_POLLS="${WATCH_MAX_POLLS:-2160}"
case "${UNFINISHED_RUN:-leave}" in
  leave|cancel) ;;
  *) echo '::error::invalid_workflow_lifecycle: expected leave or cancel' >&2; exit 1 ;;
esac
if [[ ! "$WATCH_MAX_POLLS" =~ ^[1-9][0-9]*$ ]]; then
  echo '::error::invalid_workflow_budget: max-polls must be a positive integer' >&2
  exit 1
fi

base64url() {
  openssl base64 -A | tr '/+' '_-' | tr -d '='
}

mint_app_token() {
  local now issued_at expires_at header payload unsigned signature jwt
  local installation_id repository_name request_body
  now="$(date +%s)"
  issued_at="$((now - 60))"
  expires_at="$((now + 600))"
  header="$(printf '%s' '{"typ":"JWT","alg":"RS256"}' | base64url)"
  payload="$(
    printf '{"iat":%s,"exp":%s,"iss":"%s"}' \
      "$issued_at" "$expires_at" "$APP_CLIENT_ID" | base64url
  )"
  unsigned="${header}.${payload}"
  signature="$(
    openssl dgst -sha256 -sign <(printf '%s\n' "$APP_PRIVATE_KEY") \
      <(printf '%s' "$unsigned") | base64url
  )"
  jwt="${unsigned}.${signature}"
  echo "::add-mask::${jwt}" >&2

  installation_id="$(
    GH_TOKEN="$jwt" bash "${GH_RETRY_SCRIPT:-$GITHUB_WORKSPACE/scripts/gh-retry.sh}" api -H "Authorization: Bearer ${jwt}" \
      "/repos/${INFRA_REPO}/installation" --jq '.id'
  )"
  repository_name="${INFRA_REPO#*/}"
  request_body="$(
    jq -cn --arg repository "$repository_name" \
      '{repositories: [$repository], permissions: {actions: "write"}}'
  )"
  GH_TOKEN="$jwt" bash "${GH_RETRY_SCRIPT:-$GITHUB_WORKSPACE/scripts/gh-retry.sh}" api -H "Authorization: Bearer ${jwt}" \
    --method POST \
    "/app/installations/${installation_id}/access_tokens" \
    --input - --jq '.token' <<<"$request_body"
}

refresh_app_token() {
  local token
  # Token creation is a single request; retrying can mint another token.
  if ! token="$(mint_app_token)" || [[ -z "$token" ]]; then
    echo "::error::GitHub App token renewal failed." >&2
    exit 1
  fi
  if [[ -n "${current_app_token:-}" ]]; then
    GH_TOKEN="$current_app_token" bash "${GH_RETRY_SCRIPT:-$GITHUB_WORKSPACE/scripts/gh-retry.sh}" api --method DELETE \
      "/installation/token" >/dev/null || true
  fi
  echo "::add-mask::${token}"
  current_app_token="$token"
  export GH_TOKEN="$token"
  token_refreshed_at="$(date +%s)"
}

revoke_app_token() {
  if [[ -n "${current_app_token:-}" ]]; then
    GH_TOKEN="$current_app_token" bash "${GH_RETRY_SCRIPT:-$GITHUB_WORKSPACE/scripts/gh-retry.sh}" api --method DELETE \
      "/installation/token" >/dev/null || true
  fi
}

if [[ ! "$INFRA_REPO" =~ ^[^/]+/[^/]+$ ]]; then
  echo "::error::infra-repo must be an owner/name pair." >&2
  exit 1
fi
cancel_unfinished_run() {
  if [[ "${UNFINISHED_RUN:-leave}" == cancel && -n "${run_id:-}" && "${status:-}" != completed ]]; then
    echo "Cancelling unfinished dispatched workflow: $run_id" >&2
    bash "${GH_RETRY_SCRIPT:-$GITHUB_WORKSPACE/scripts/gh-retry.sh}" api --method POST "/repos/$INFRA_REPO/actions/runs/$run_id/cancel" >/dev/null || true
  fi
}
current_app_token=""
trap 'cancel_unfinished_run; revoke_app_token' EXIT
trap 'exit 143' TERM INT
if [[ -n "${DISPATCH_TOKEN:-}" ]]; then
  export GH_TOKEN="$DISPATCH_TOKEN"
  token_refreshed_at="$(date +%s)"
else
  refresh_app_token
fi

dispatched_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
expected_title="$EXPECTED_TITLE"
dispatch_body="$(jq -cn --arg ref "$DISPATCH_REF" --argjson inputs "$DISPATCH_INPUTS" '{ref:$ref, inputs:$inputs}')"

# Call the dispatches endpoint directly. `gh workflow run` first looks
# up the workflow by filename against the repo's default branch; with
# the narrowly-scoped App token (permission-actions: write only, no
# contents/metadata) those implicit lookups can fail silently and kill
# the step in well under a second with no output. Any failure here
# surfaces as a real HTTP error in the log.
echo "Dispatching ${WORKFLOW_FILE} on ${INFRA_REPO} ..."
bash "${GH_RETRY_SCRIPT:-$GITHUB_WORKSPACE/scripts/gh-retry.sh}" api --method POST \
  "/repos/${INFRA_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches" \
  --input - <<<"$dispatch_body"

# The dispatches endpoint returns 204 with no body, so the run id has
# to be recovered by listing. Match on exact display_title so
# concurrent dispatches cannot be confused and prefix-overlapping refs
# (v1.2.3 vs v1.2.3-rc.1, v1.2.3-rc.1 vs v1.2.3-rc.10) never collide.
echo "Dispatch accepted. Polling for the new run..."
run_id=""
for attempt in {1..30}; do
  # Poll successful reads until the run appears. HTTP recovery belongs
  # to the shared owner; a failed read exhausts that request's budget.
  if ! run_id="$(
    bash "${GH_RETRY_SCRIPT:-$GITHUB_WORKSPACE/scripts/gh-retry.sh}" api \
      "/repos/${INFRA_REPO}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=10" \
      --jq ".workflow_runs[] | select(.created_at >= \"${dispatched_at}\") | select(.display_title == \"${expected_title}\") | .id" \
      | head -n 1
  )"; then
    echo "::error::Dispatched run lookup failed." >&2
    exit 1
  fi
  if [[ -n "$run_id" ]]; then
    echo "Found dispatched run: ${run_id} (attempt ${attempt}/30)"
    break
  fi
  sleep 2
done

if [[ -z "$run_id" ]]; then
  echo "::error::Dispatched run did not appear in the workflow run list." >&2
  exit 1
fi

run_url="https://github.com/${INFRA_REPO}/actions/runs/${run_id}"
echo "Watching run ${run_id}..."
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "run-url=$run_url" >> "$GITHUB_OUTPUT"
fi
for ((poll=0; poll<WATCH_MAX_POLLS; poll++)); do
  now="$(date +%s)"
  if [[ -n "${WATCH_DEADLINE_EPOCH:-}" ]] && ((now>=WATCH_DEADLINE_EPOCH)); then
    echo "::error::workflow_run_timeout: stage deadline reached: $run_url" >&2
    exit 1
  fi
  if [[ -z "${DISPATCH_TOKEN:-}" ]] && (( now - token_refreshed_at >= TOKEN_REFRESH_SECONDS )); then
    echo "Refreshing promotion watcher credentials..."
    refresh_app_token
  fi

  if ! run_state="$(
    bash "${GH_RETRY_SCRIPT:-$GITHUB_WORKSPACE/scripts/gh-retry.sh}" api "/repos/${INFRA_REPO}/actions/runs/${run_id}" \
      --jq '[.status, .conclusion, .html_url] | @tsv'
  )"; then
    echo "::error::Promote run status lookup failed. Check ${run_url}" >&2
    exit 1
  fi
  status="$(cut -f1 <<<"$run_state")"
  conclusion="$(cut -f2 <<<"$run_state")"
  run_url="$(cut -f3 <<<"$run_state")"
  if [[ "$status" == "completed" ]]; then
    break
  fi
  sleep "$WATCH_POLL_SECONDS"
done
if [[ "$status" != "completed" ]]; then
  echo "::error::workflow_run_timeout: $run_url" >&2
  exit 1
fi

if [[ "$conclusion" == "success" ]]; then
  if [[ -n "${RECEIPT_ARTIFACT:-}" ]]; then
    artifact_id=$(bash "${GH_RETRY_SCRIPT:-$GITHUB_WORKSPACE/scripts/gh-retry.sh}" api "/repos/$INFRA_REPO/actions/runs/$run_id/artifacts" | jq -r --arg name "$RECEIPT_ARTIFACT" '.artifacts[] | select(.name == $name) | .id')
    if [[ ! "$artifact_id" =~ ^[0-9]+$ ]]; then
      echo "::error::workflow_receipt_missing: $RECEIPT_ARTIFACT" >&2
      exit 1
    fi
    archive=$(mktemp)
    bash "${GH_RETRY_SCRIPT:-$GITHUB_WORKSPACE/scripts/gh-retry.sh}" api "/repos/$INFRA_REPO/actions/artifacts/$artifact_id/zip" > "$archive"
    unzip -p "$archive" "$RECEIPT_ARTIFACT.json" > "$RUNNER_TEMP/$RECEIPT_ARTIFACT.json"
    rm -f "$archive"
    jq -e 'type == "object"' "$RUNNER_TEMP/$RECEIPT_ARTIFACT.json" >/dev/null
    echo "receipt=$RUNNER_TEMP/$RECEIPT_ARTIFACT.json" >> "$GITHUB_OUTPUT"
  fi
  echo "Promote run completed successfully: ${run_url}"
  exit 0
fi

# A cancelled promote stays fatal. When a newer push superseded this
# one, the caller is being torn down by its own concurrency group
# anyway, so nobody reads this result. When a human cancelled it, the
# deploy genuinely did not land, and passing here would hand the
# post-deploy smoke a commit that will never arrive: it would then
# block for its full readiness window and report the wrong thing.
if [[ "$conclusion" == "cancelled" ]]; then
  echo "::error::Promote run was cancelled (superseded by a newer push, or cancelled manually): ${run_url}" >&2
  exit 1
fi

echo "::error::Promote run finished with conclusion '${conclusion}': ${run_url}" >&2
exit 1
