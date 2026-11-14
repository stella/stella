#!/usr/bin/env bash
# Runs every release tag gate and reports them together. Each gate step records
# its own outcome and keeps its exit status; the verdict then lists every gate
# that failed or never ran, so one run names all the work left before a tag.
#
#   release-gate.sh run <gate> <command...>   run one gate and record it
#   release-gate.sh verdict <gate>...         list each failed or unrun gate
#
# Records live in RELEASE_GATE_DIR (default: $RUNNER_TEMP/release-gates).
set -euo pipefail

dir="${RELEASE_GATE_DIR:-${RUNNER_TEMP:?RUNNER_TEMP or RELEASE_GATE_DIR is required}/release-gates}"
usage() { echo "::error::Usage: release-gate.sh run <gate> <command...> | verdict <gate>..." >&2; exit 2; }
valid_gate() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "::error::Invalid release gate name: $1" >&2; exit 2; }; }

# The reason a gate failed: its own error annotations, else its last stderr line.
reason() {
  local out="$1" err="$2" status="$3" lines
  lines=$(sed -n 's/^::error[^:]*:://p' "$out" "$err" 2>/dev/null | paste -sd ';' - | sed 's/;/; /g')
  [[ -n "$lines" ]] || lines=$(grep -v '^[[:space:]]*$' "$err" 2>/dev/null | tail -n 1 || true)
  printf '%s\n' "${lines:-exit $status}"
}

case "${1-}" in
  run)
    [[ $# -ge 3 ]] || usage
    gate="$2"
    shift 2
    valid_gate "$gate"
    mkdir -p "$dir"
    # Both streams stay with the caller; copies let the verdict find annotations.
    status=0
    "$@" >"$dir/$gate.stdout" 2>"$dir/$gate.stderr" || status=$?
    cat "$dir/$gate.stdout"
    cat "$dir/$gate.stderr" >&2
    printf '%s\n' "$status" >"$dir/$gate.status"
    exit "$status"
    ;;
  verdict)
    [[ $# -ge 2 ]] || usage
    shift
    failures=()
    for gate in "$@"; do
      valid_gate "$gate"
      if [[ ! -f "$dir/$gate.status" ]]; then
        failures+=("$gate: did not run")
        continue
      fi
      status=$(<"$dir/$gate.status")
      [[ "$status" == 0 ]] || failures+=("$gate: $(reason "$dir/$gate.stdout" "$dir/$gate.stderr" "$status")")
    done
    summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
    if [[ ${#failures[@]} -eq 0 ]]; then
      echo "All $# release gates passed."
      printf '### Release gates\n\nAll %s gates passed.\n' "$#" >>"$summary"
      exit 0
    fi
    printf '### Release gates\n\n%s of %s gates failed:\n\n' "${#failures[@]}" "$#" >>"$summary"
    for failure in "${failures[@]}"; do
      echo "::error::RELEASE_GATE_FAILED $failure"
      printf -- '- %s\n' "$failure" >>"$summary"
    done
    echo "${#failures[@]} of $# release gates failed."
    exit 1
    ;;
  *) usage ;;
esac
