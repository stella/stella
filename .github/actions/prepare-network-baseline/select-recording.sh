#!/usr/bin/env bash
# Sourced by prepare.sh; API failures must never seed the committed bootstrap.
recorded=false
recorded_source=''
selection_log() {
  printf 'Network baseline: %s\n' "$*" >> "$GITHUB_STEP_SUMMARY"
  printf 'Network baseline: %s\n' "$*" >&2
}
selection_error() {
  selection_log "ERROR $*"
  exit 1
}
selection_api() {
  local response error_file reason
  error_file=$(mktemp "$RUNNER_TEMP/baseline-api.XXXXXX")
  if ! response=$(bash "$gh_retry_script" api "$@" 2>"$error_file"); then
    reason=$(cat "$error_file")
    rm "$error_file"
    selection_error "candidate=$selection_source API $*: $reason"
  fi
  rm "$error_file"
  printf '%s\n' "$response"
}
load_recording() {
  local source=$1 name artifacts rows id run_id run verdict count artifact_dir
  selection_source=$source
  name="network-baseline-main-$source"
  artifacts=$(selection_api --method GET "repos/$REPOSITORY/actions/artifacts" -f name="$name" -f per_page=100)
  if ! jq -es 'length == 1 and (.[0] | type == "object" and (.total_count | type == "number") and (.artifacts | type == "array") and all(.artifacts[];
    (.id | type == "number") and (.name | type == "string") and (.expired | type == "boolean") and (.workflow_run.id | type == "number")))' <<< "$artifacts" >/dev/null; then
    selection_error "candidate=$source artifacts=unknown unparsable artifacts response"
  fi
  count=$(jq '.artifacts | length' <<< "$artifacts")
  rows=$(jq -r --arg name "$name" '.artifacts | sort_by(.id) | reverse | .[] | select(.name == $name and .expired == false) | [.id, .workflow_run.id] | @tsv' <<< "$artifacts")
  selection_log "candidate=$source artifacts=$count verdict=$(if [[ -n "$rows" ]]; then echo checking-runs; else echo no-usable-artifact; fi)"
  # Existing delivered artifacts remain usable for their retention period. New
  # recordings publish in the recording run itself via the reusable delivery job.
  while IFS=$'\t' read -r id run_id; do
    [[ -n "$id" ]] || continue
    run=$(selection_api "repos/$REPOSITORY/actions/runs/$run_id")
    if ! jq -es 'length == 1 and (.[0] | type == "object" and all(.path, .event, .head_branch, .head_sha, .head_repository.full_name; type == "string") and
      (.conclusion == null or (.conclusion | type == "string")))' <<< "$run" >/dev/null; then
      selection_error "candidate=$source artifacts=$count run=$run_id unparsable run response"
    fi
    verdict=$(jq -c '{path,event,conclusion,head_branch,head_sha,repository:.head_repository.full_name}' <<< "$run")
    if ! jq -e --arg source "$source" --arg repository "$REPOSITORY" '
      .conclusion == "success" and .head_branch == "main" and .head_repository.full_name == $repository and (
        (.path == ".github/workflows/network-baseline-deliver.yml" and .event == "workflow_run") or
        (.path == ".github/workflows/network-baseline-record.yml" and (.event == "schedule" or .event == "workflow_dispatch") and .head_sha == $source)
      )' <<< "$run" >/dev/null; then
      selection_log "candidate=$source artifacts=$count artifact=$id run=$run_id verdict=skipped $verdict"
      continue
    fi
    selection_log "candidate=$source artifacts=$count artifact=$id run=$run_id verdict=accepted $verdict"
    artifact_dir=$(mktemp -d "$RUNNER_TEMP/main-baseline.XXXXXX")
    if ! bash "$gh_retry_script" api "repos/$REPOSITORY/actions/artifacts/$id/zip" > "$artifact_dir/baseline.zip"; then
      selection_error "candidate=$source artifacts=$count run=$run_id artifact download failed ($id)"
    fi
    unzip -q "$artifact_dir/baseline.zip" -d "$artifact_dir/data"
    bun scripts/network-baseline-scope.ts validate "$artifact_dir/data/network-baseline.json"
    cp "$artifact_dir/data/network-baseline.json" apps/web/e2e/.network-baseline-base.json
    rm -r "$artifact_dir"
    selection_log "validated main recording at $source (merge base $base)"
    recorded=true
    recorded_source=$source
    return
  done <<< "$rows"
}
selection_source=$base
load_recording "$base"
if [[ "$recorded" == false ]]; then
  runs=$(selection_api --method GET "repos/$REPOSITORY/actions/workflows/network-baseline-record.yml/runs" -f branch=main -f status=success -f per_page=100)
  if ! jq -es 'length == 1 and (.[0] | type == "object" and (.workflow_runs | type == "array") and all(.workflow_runs[];
    (.event | type == "string") and (.head_sha | type == "string" and test("^[a-f0-9]{40}$"))))' <<< "$runs" >/dev/null; then
    selection_error "candidate=$base unparsable recording runs response"
  fi
  candidates=$(jq -r '.workflow_runs[] | select(.event == "schedule" or .event == "workflow_dispatch") | .head_sha' <<< "$runs")
  # Materialize the walk so git failure cannot disappear in process substitution.
  walk=$(git rev-list --topo-order "$base")
  while read -r source; do
    [[ "$source" != "$base" ]] || continue
    case $'\n'"$candidates"$'\n' in
      *$'\n'"$source"$'\n'*) ;;
      *) selection_log "candidate=$source artifacts=not-queried verdict=no-successful-record-run"; continue ;;
    esac
    load_recording "$source"
    if [[ "$recorded" == true ]]; then break; fi
  done <<< "$walk"
fi
if [[ "$recorded" == false ]]; then
  selection_log "committed bootstrap at merge base $base (recording unavailable)"
fi
