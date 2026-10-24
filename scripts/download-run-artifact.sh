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
# failed or stalled attempt is retried once after
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
trap 'rm -rf "$staging"' EXIT
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
  if ((status == 0)); then
    attempt_outcome='succeeded'
    return 0
  fi
  last_line=$(awk 'NF { line = $0 } END { print line }' "$errors" | tr -d '\r')
  [[ -n "$last_line" ]] || last_line='no stderr output'
  # timeout exits 124 when it stopped the command and 137 when it had to kill
  # it; a command that itself exits 124 before the bound is reported as such.
  if ((status == 124 || status == 137)) && ((SECONDS - started >= attempt_seconds)); then
    attempt_outcome="timed out after $attempt_seconds s ($last_line)"
  else
    attempt_outcome="exit code $status ($last_line)"
  fi
  return 1
}

# Files of every artifact sub-directory move into one tree; a file two
# artifacts both carry is refused instead of letting the last one win.
merge_artifacts() {
  local source=$1
  local target=$2
  local artifact relative
  mkdir "$target"
  for artifact in "$source"/*; do
    [[ -d "$artifact" ]] || continue
    while IFS= read -r relative; do
      relative=${relative#./}
      if [[ -e "$target/$relative" || -L "$target/$relative" ]]; then
        annotate_error "Artifact download for $label in $run_label: '$relative' is in more than one matching artifact (one is '${artifact##*/}'); merged artifacts must not share file names"
        return 1
      fi
      mkdir -p "$(dirname "$target/$relative")"
      mv "$artifact/$relative" "$target/$relative"
    done < <(cd "$artifact" && find . \( -type f -o -type l \) | LC_ALL=C sort)
  done
}

started=$SECONDS
first_outcome=''
completed=''
for attempt in 1 2; do
  if run_attempt "$attempt"; then
    completed="$staging/attempt-$attempt"
    break
  fi
  if ((attempt == 1)); then
    first_outcome=$attempt_outcome
    echo "Artifact download attempt 1 for $label $attempt_outcome; retrying in ${pause_seconds}s" >&2
    sleep "$pause_seconds"
  fi
done
if [[ -z "$completed" ]]; then
  annotate_error "Artifact download failed for $label in $run_label: attempt 1 $first_outcome; attempt 2 $attempt_outcome"
  exit 1
fi

if [[ "$merge" == true ]]; then
  merge_artifacts "$completed" "$staging/merged"
  completed="$staging/merged"
fi

files=$(find "$completed" \( -type f -o -type l \) | wc -l | tr -d ' ')
kib=$(du -sk "$completed" | awk '{ print $1 }')

# The destination receives a finished tree: renamed into place when it is
# absent or empty, otherwise copied over like an archive extraction.
if [[ -d "$destination" ]] && [[ -z "$(ls -A "$destination")" ]]; then
  rmdir "$destination"
fi
if [[ -e "$destination" ]]; then
  cp -R "$completed/." "$destination/"
else
  mkdir -p "$(dirname "$destination")"
  mv "$completed" "$destination"
fi

echo "Downloaded $label from $run_label: $files files, $kib KiB in $((SECONDS - started)) s (attempt $attempt)"
