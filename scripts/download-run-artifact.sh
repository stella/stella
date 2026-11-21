#!/usr/bin/env bash
set -euo pipefail

# Downloads artifacts of the current workflow run.
#
#   download-run-artifact.sh --name NAME --path DIR
#   download-run-artifact.sh --pattern GLOB [--merge] --path DIR
#
# --merge puts the files of every matching artifact directly into DIR, like
# actions/download-artifact with merge-multiple: true, and refuses two
# artifacts that carry the same file. Without it each match lands in
# DIR/<artifact name>.
#
# Each attempt runs under `timeout` (ARTIFACT_DOWNLOAD_ATTEMPT_SECONDS, default
# 60) into a fresh directory; DIR changes only after an attempt completes. A
# timed-out attempt is retried once after
# ARTIFACT_DOWNLOAD_RETRY_PAUSE_SECONDS (default 5).
#
# Needs GH_TOKEN, GITHUB_RUN_ID and GITHUB_REPOSITORY. bash 3.2 compatible.

usage() {
  echo 'usage: download-run-artifact.sh (--name NAME | --pattern GLOB [--merge]) --path DIR' >&2
  exit 2
}

name=''
pattern=''
destination=''
merge=false
while (($# > 0)); do
  case "$1" in
    --name) (($# >= 2)) || usage; name=$2; shift 2 ;;
    --pattern) (($# >= 2)) || usage; pattern=$2; shift 2 ;;
    --path) (($# >= 2)) || usage; destination=$2; shift 2 ;;
    --merge) merge=true; shift ;;
    *) usage ;;
  esac
done
if [[ -z "$destination" ]] || [[ -n "$name" && -n "$pattern" ]] || [[ -z "$name" && -z "$pattern" ]]; then
  usage
fi
if [[ "$merge" == true && -z "$pattern" ]]; then
  echo '--merge applies to --pattern downloads only' >&2
  exit 2
fi
: "${GH_TOKEN:?GH_TOKEN must hold a token with actions: read}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID must name the workflow run}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must name the repository}"

attempt_seconds=${ARTIFACT_DOWNLOAD_ATTEMPT_SECONDS:-60}
pause_seconds=${ARTIFACT_DOWNLOAD_RETRY_PAUSE_SECONDS:-5}
if [[ ! "$attempt_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "ARTIFACT_DOWNLOAD_ATTEMPT_SECONDS must be a positive whole number of seconds, got '$attempt_seconds'" >&2
  exit 2
fi
if [[ ! "$pause_seconds" =~ ^[0-9]+$ ]]; then
  echo "ARTIFACT_DOWNLOAD_RETRY_PAUSE_SECONDS must be a whole number of seconds, got '$pause_seconds'" >&2
  exit 2
fi

gh_retry_script="${GH_RETRY_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/gh-retry.sh}"
if [[ -n "$name" ]]; then
  selector=(--name "$name")
  label="artifact '$name'"
else
  selector=(--pattern "$pattern")
  label="artifacts matching '$pattern'"
fi
run_label="run $GITHUB_RUN_ID of $GITHUB_REPOSITORY"

# Workflow commands end at a newline; % introduces an escape.
annotate_error() {
  local message=$1
  message=${message//%/%25}
  message=${message//$'\r'/%0D}
  message=${message//$'\n'/%0A}
  echo "::error::$message"
}

staging=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/run-artifact.XXXXXX")
publication_staging=''
cleanup() {
  local status=$?
  trap - EXIT
  [[ -z "$publication_staging" ]] || rm -rf "$publication_staging"
  rm -rf "$staging"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Sets attempt_outcome; succeeds only when the attempt directory is complete.
run_attempt() {
  local attempt=$1
  local directory="$staging/attempt-$attempt"
  local errors="$staging/stderr-$attempt"
  local started=$SECONDS
  local status=0
  local last_line
  mkdir "$directory"
  timeout --kill-after=10 "$attempt_seconds" \
    bash "$gh_retry_script" run download "$GITHUB_RUN_ID" \
    --repo "$GITHUB_REPOSITORY" "${selector[@]}" --dir "$directory" \
    </dev/null 2>"$errors" || status=$?
  cat "$errors" >&2
  attempt_timed_out=false
  if ((status == 0)); then
    attempt_outcome='succeeded'
    return 0
  fi
  last_line=$(awk 'NF { line = $0 } END { print line }' "$errors" | tr -d '\r')
  [[ -n "$last_line" ]] || last_line='no stderr output'
  # timeout exits 124 when it stopped the command and 137 when it had to kill
  # it; a command that itself exits 124 before the bound is reported as such.
  if ((status == 124 || status == 137)) && ((SECONDS - started >= attempt_seconds)); then
    attempt_timed_out=true
    attempt_outcome="timed out after $attempt_seconds s ($last_line)"
  else
    attempt_outcome="exit code $status ($last_line)"
  fi
  return 1
}

# Reject links and special nodes before flattening or writing any destination.
validate_source() {
  local source=$1 manifest=$2 entry
  find "$source" -print0 > "$manifest" || return 1
  while IFS= read -r -d '' entry; do
    if [[ -L "$entry" || ! -d "$entry" && ! -f "$entry" ]]; then
      annotate_error "Artifact download for $label in $run_label contains a symlink or special node"
      return 1
    fi
  done < "$manifest"
}

# Each artifact keeps a directory even when a pattern resolves to one match.
# Only this subshell enables dotglob, so hidden artifact names are included.
merge_artifacts() (
  local source=$1 target=$2 artifact entry relative output
  shopt -s dotglob nullglob
  mkdir "$target"
  for artifact in "$source"/*; do
    if [[ ! -d "$artifact" ]]; then
      annotate_error "Artifact download for $label in $run_label has a non-directory artifact root"
      return 1
    fi
    find "$artifact" -mindepth 1 -print0 > "$staging/merge-nodes" || return 1
    while IFS= read -r -d '' entry; do
      relative=${entry#"$artifact/"}
      output="$target/$relative"
      if [[ -e "$output" ]] && { [[ ! -d "$entry" ]] || [[ ! -d "$output" ]]; }; then
        annotate_error "Artifact download for $label in $run_label: '$relative' is in more than one matching artifact (one is '${artifact##*/}'); merged artifacts must not share file names"
        return 1
      fi
      if [[ -d "$entry" ]]; then
        mkdir -p "$output" || return 1
      else
        mkdir -p "${output%/*}" || return 1
        cp -p "$entry" "$output" || return 1
      fi
    done < "$staging/merge-nodes"
  done
)

# Validate the complete overlay, including its ancestors, before copying any
# file. Unrelated existing entries are not inspected or replaced.
validate_destination() {
  local manifest=$1 entry relative target ancestor
  ancestor=$destination
  while [[ -n "$ancestor" ]]; do
    if [[ -L "$ancestor" || -e "$ancestor" && ! -d "$ancestor" ]]; then
      annotate_error "Artifact download destination has a symlink or non-directory ancestor"
      return 1
    fi
    [[ "$ancestor" != / ]] || break
    ancestor=${ancestor%/*}
    [[ -n "$ancestor" ]] || ancestor=/
  done
  while IFS= read -r -d '' entry; do
    [[ "$entry" != "$completed" ]] || continue
    relative=${entry#"$completed/"}
    target="$destination/$relative"
    if [[ -L "$target" ]]; then
      annotate_error "Artifact download destination contains an affected symlink"
      return 1
    fi
    if [[ -f "$target" ]]; then
      find "$target" -prune -type f -links +1 -print0 > "$staging/target-links" || return 1
      if [[ -s "$staging/target-links" ]]; then
        annotate_error "Artifact download destination contains an affected hardlink"
        return 1
      fi
    fi
    if [[ -e "$target" ]] && { [[ -d "$entry" && ! -d "$target" ]] || [[ -f "$entry" && ! -f "$target" ]]; }; then
      annotate_error "Artifact download destination has a file/directory type conflict"
      return 1
    fi
  done < "$manifest"
}

case "$destination" in
  /*) ;;
  *) destination="$PWD/$destination" ;;
esac
while [[ "$destination" != / && "$destination" == */ ]]; do
  destination=${destination%/}
done

# A successful empty pattern listing is optional absence. A permanent or
# unknown listing failure stays terminal; only a deadline permits a download
# that might succeed without the listing. gh-retry owns HTTP/transport policy.
pattern_empty=false
if [[ -n "$pattern" ]]; then
  listing_started=$SECONDS
  listing_status=0
  listed=$(timeout --kill-after=10 "$attempt_seconds" \
    bash "$gh_retry_script" api --paginate \
    "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/artifacts?per_page=100" \
    --jq '.artifacts[] | select(.expired | not) | .name' </dev/null) || listing_status=$?
  if ((listing_status == 0)); then
    pattern_empty=true
    while IFS= read -r artifact_name; do
      # shellcheck disable=SC2053 # the pattern is a glob on purpose
      if [[ -n "$artifact_name" && "$artifact_name" == $pattern ]]; then
        pattern_empty=false
        break
      fi
    done <<< "$listed"
  elif (( (listing_status == 124 || listing_status == 137) && SECONDS - listing_started >= attempt_seconds )); then
    echo "Listing the artifacts of $run_label timed out; downloading $label anyway." >&2
  else
    annotate_error "Artifact listing failed for $label in $run_label (exit code $listing_status)"
    exit 1
  fi
fi

started=$SECONDS
first_outcome=''
completed=''
attempt=0
if [[ "$pattern_empty" == true ]]; then
  completed="$staging/empty"
  mkdir "$completed"
else
  for attempt in 1 2; do
    if run_attempt "$attempt"; then
      completed="$staging/attempt-$attempt"
      break
    fi
    if ((attempt == 1)) && [[ "$attempt_timed_out" == true ]]; then
      first_outcome=$attempt_outcome
      echo "Artifact download attempt 1 for $label $attempt_outcome; retrying in ${pause_seconds}s" >&2
      sleep "$pause_seconds"
    else
      break
    fi
  done
  if [[ -z "$completed" ]]; then
    outcomes="attempt $attempt $attempt_outcome"
    [[ -z "$first_outcome" ]] || outcomes="attempt 1 $first_outcome; $outcomes"
    annotate_error "Artifact download failed for $label in $run_label: $outcomes"
    exit 1
  fi
fi

validate_source "$completed" "$staging/source-nodes"
if [[ "$merge" == true && "$pattern_empty" != true ]]; then
  merge_artifacts "$completed" "$staging/merged"
  completed="$staging/merged"
fi
validate_source "$completed" "$staging/completed-nodes"
validate_destination "$staging/completed-nodes"
files=0
while IFS= read -r -d '' entry; do
  [[ ! -f "$entry" ]] || files=$((files + 1))
done < "$staging/completed-nodes"
kib=$(du -sk "$completed" | awk '{ print $1 }')

# Existing directories are validated overlays, not a whole-tree atomic swap.
# An absent destination is fully copied on its parent's filesystem before
# renaming it into place, even when RUNNER_TEMP is on a different filesystem.
if [[ -d "$destination" ]]; then
  validate_destination "$staging/completed-nodes"
  cp -R "$completed/." "$destination/"
else
  parent=${destination%/*}
  [[ -n "$parent" ]] || parent=/
  mkdir -p "$parent"
  publication_staging=$(mktemp -d "$parent/.run-artifact.XXXXXX")
  mkdir "$publication_staging/tree"
  cp -R "$completed/." "$publication_staging/tree/"
  validate_destination "$staging/completed-nodes"
  if [[ -e "$destination" || -L "$destination" ]]; then
    annotate_error "Artifact download destination appeared during publication"
    exit 1
  fi
  mv "$publication_staging/tree" "$destination"
fi

if [[ "$pattern_empty" == true ]]; then
  echo "No artifact of $run_label matches '$pattern'; nothing to download."
else
  echo "Downloaded $label from $run_label: $files files, $kib KiB in $((SECONDS - started)) s (attempt $attempt)"
fi
