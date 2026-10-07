#!/usr/bin/env bash
set -euo pipefail

# GitHub response traces stay in a private directory: they contain credentials
# and payloads. Only HTTP status/retry metadata may leave that directory.
# bash 3.2 is required by macOS and Windows release runners.

if (($# == 0)); then
  echo 'usage: gh-retry.sh <gh subcommand> [args...]' >&2
  exit 2
fi
case "$1" in
  api|run|release) ;;
  *) exec gh "$@" ;;
esac

umask 077
scratch=$(mktemp -d)
command_pid=''
watchdog=''
cleanup() {
  # Early watchdog termination can run the inherited EXIT trap on GNU Bash.
  # Only the owning shell may remove response files or terminate commands.
  ((BASH_SUBSHELL == 0)) || return 0
  [[ -z "$command_pid" ]] || kill "$command_pid" 2>/dev/null || true
  [[ -z "$watchdog" ]] || kill "$watchdog" 2>/dev/null || true
  rm -rf "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

args=("$@")
retryable=false
transport_retryable=false
method=GET
explicit_method=''
endpoint=''
query=''
stdin_needed=false
# Consume option values as values; filenames after -- are never flags.
for ((i=1; i<${#args[@]}; i+=1)); do
  arg="${args[i]}"
  case "$arg" in
    --) [[ -n "$endpoint" ]] || endpoint="${args[i+1]:-}"; break ;;
    --method|-X) i=$((i+1)); explicit_method="${args[i]:-}" ;;
    --method=*) explicit_method="${arg#*=}" ;;
    -X?*) explicit_method="${arg#-X}" ;;
    --input)
      method=POST; i=$((i+1))
      [[ "${args[i]:-}" != - ]] || stdin_needed=true
      ;;
    --input=*) method=POST; [[ "$arg" != --input=- ]] || stdin_needed=true ;;
    -f|-F|--field|--raw-field)
      flag="$arg"; method=POST; i=$((i+1)); value="${args[i]:-}"
      [[ "$value" != query=* ]] || query="${value#query=}"
      if [[ "$flag" == -F || "$flag" == --field ]] && [[ "$value" == *@- ]]; then stdin_needed=true; fi
      ;;
    --field=*|--raw-field=*|-f?*|-F?*)
      method=POST
      case "$arg" in
        --field=*|--raw-field=*) value="${arg#*=}" ;;
        *) value="${arg:2}" ;;
      esac
      [[ "$value" != query=* ]] || query="${value#query=}"
      if [[ "$arg" == --field=* || "$arg" == -F?* ]] && [[ "$value" == *@- ]]; then stdin_needed=true; fi
      ;;
    --jq|-q|--header|-H|--hostname|--cache|--template|-t|--preview|-p) i=$((i+1)) ;;
    -*) ;;
    *) [[ -n "$endpoint" ]] || endpoint="$arg" ;;
  esac
done
[[ -z "$explicit_method" ]] || method="$explicit_method"
case "${args[0]}" in
  api)
    if [[ "$method" == GET || "$method" == HEAD ]]; then
      retryable=true; transport_retryable=true
    elif [[ "$endpoint" == graphql && "$query" =~ ^[[:space:]]*(query[[:space:]\(\{]|\{) && ! "$query" =~ (^|[^[:alnum:]_])mutation([^[:alnum:]_]|$) ]]; then
      # GraphQL queries use POST transport, but do not mutate repository state.
      retryable=true
    fi
    ;;
  run) [[ "${args[1]:-}" != list && "${args[1]:-}" != view && "${args[1]:-}" != watch && "${args[1]:-}" != download ]] || { retryable=true; transport_retryable=true; } ;;
  release)
    case "${args[1]:-}" in
      view|download) retryable=true; transport_retryable=true ;;
      upload)
        # Replacing assets by name is the only admitted write. Partial uploads
        # are replaced; creation, dispatch, status rows and mutations run once.
        for arg in "${args[@]}"; do
          [[ "$arg" != -- ]] || break
          case "$arg" in
            --clobber|--clobber=true) retryable=true ;;
            --clobber=false) retryable=false ;;
          esac
        done
        ;;
    esac
    ;;
esac

if [[ "$stdin_needed" == true ]]; then
  cat > "$scratch/input"
else
  # Do not consume a caller's loop input merely because it invoked gh.
  : > "$scratch/input"
fi

# Downloads are isolated per attempt. A partial archive extraction never
# changes the destination, and the next attempt starts with an empty directory.
destination=''
clobber=false
if [[ "${args[0]}" == run || "${args[0]}" == release ]] && [[ "${args[1]:-}" == download ]]; then
  destination=.
  has_directory=false
  for ((i=2; i<${#args[@]}; i+=1)); do
    case "${args[i]}" in
      --) break ;;
      # A named output file is written in place and would keep a failed
      # attempt's partial bytes; downloads go through --dir only.
      -O|-O*|--output|--output=*)
        echo "GitHub downloads through the retry helper use --dir; --output is not supported" >&2
        exit 2 ;;
      -p|--pattern|-n|--name|-R|--repo) i=$((i+1)) ;;
      -D|--dir) destination="${args[i+1]}"; args[i+1]="$scratch/download"; has_directory=true; i=$((i+1)) ;;
      --dir=*) destination="${args[i]#*=}"; args[i]="--dir=$scratch/download"; has_directory=true ;;
      --clobber|--clobber=true) clobber=true ;;
      --clobber=false) clobber=false ;;
    esac
  done
  [[ "$has_directory" == true ]] || args=("${args[@]:0:2}" --dir "$scratch/download" "${args[@]:2}")
fi

started=$SECONDS
for ((attempt=1; attempt<=4; attempt+=1)); do
  if [[ -n "$destination" ]]; then
    rm -rf "$scratch/download"
    mkdir "$scratch/download"
  fi
  # REST requests and recovery share a 60-second wall budget. High-level
  # first attempts keep their normal lifetime (watching/uploading artifacts).
  GH_DEBUG=api gh "${args[@]}" < "$scratch/input" > "$scratch/output" 2> "$scratch/trace" &
  command_pid=$!
  watchdog=''
  if ((attempt > 1)) || [[ "${args[0]}" == api ]]; then
    remaining=$((60 - SECONDS + started))
    (
      sleep "$remaining" &
      timer=$!
      trap 'kill "$timer" 2>/dev/null || true' EXIT
      trap 'exit 0' TERM
      wait "$timer"
      : > "$scratch/deadline"
      kill "$command_pid" 2>/dev/null || true
    ) </dev/null >/dev/null 2>&1 &
    watchdog=$!
  fi
  if wait "$command_pid"; then status=0; else status=$?; fi
  command_pid=''
  if [[ -n "$watchdog" ]]; then
    kill "$watchdog" 2>/dev/null || true
    wait "$watchdog" 2>/dev/null || true
    watchdog=''
  fi
  if [[ -e "$scratch/deadline" ]]; then
    echo "GitHub retry budget exhausted on attempt $attempt/4" >&2
    exit 124
  fi
  if ((status == 0)); then
    if [[ -n "$destination" ]]; then
      if [[ "${args[0]}" == release && "$clobber" == false ]]; then
        while IFS= read -r file; do
          if [[ -e "$destination/${file#"$scratch/download/"}" ]]; then
            echo 'GitHub download destination already contains an asset; use --clobber to replace it' >&2
            exit 1
          fi
        done < <(find "$scratch/download" -type f)
      fi
      mkdir -p "$destination"
      cp -R "$scratch/download/." "$destination/"
    fi
    cat "$scratch/output"
    exit 0
  fi
  # cli/cli's HTTP logger prefixes response headers with "< ".
  # Select the last response, including its Retry-After, not a redirect/page.
  read -r http retry_after < <(awk '
    BEGIN { after=-1 }
    /^\* Request to / { status=0; after=-1 }
    /^< HTTP\/[0-9.]+ [0-9]+/ { status=$3; after=-1 }
    tolower($0) ~ /^< retry-after:/ { after=$0; sub(/^<[^:]*: */, "", after); sub(/\r$/, "", after) }
    END { print status+0, after }
  ' "$scratch/trace")
  if [[ "$retry_after" != -1 && ! "$retry_after" =~ ^[0-9]+$ ]]; then
    # Retry-After accepts either seconds or an HTTP date. GNU and BSD date
    # have different parsing switches; both produce the same epoch value.
    if epoch=$(LC_ALL=C date -u -d "$retry_after" +%s 2>/dev/null) ||
      epoch=$(LC_ALL=C date -j -u -f '%a, %d %b %Y %H:%M:%S GMT' "$retry_after" +%s 2>/dev/null); then
      retry_after=$((epoch - $(date +%s)))
      ((retry_after >= 0)) || retry_after=0
    else
      retry_after=-1
    fi
  fi
  # Native gh errors also carry a status when the transport did not log headers.
  if ((http == 0)); then
    native_http=$(sed -n 's/^gh:.*(HTTP \([0-9][0-9][0-9]\)).*$/\1/p' "$scratch/trace" | tail -n 1)
    [[ -z "$native_http" ]] || http="$native_http"
  fi
  failure="HTTP $http"
  transient=false
  if ((http >= 500 && http <= 599 || http == 429 || http == 403 && retry_after >= 0)); then
    transient=true
  elif ((http == 0)) && [[ "$transport_retryable" == true ]] && awk '
    # Match Go transport errors logged by gh, not headers, payloads or decoder
    # failures mentioning EOF. Unknown non-HTTP failures stay single-shot.
    {
      line=tolower($0); sub(/^\* /, "", line)
      network = line ~ /^((get|head|post|patch|put|delete) +"https?:\/\/[^"]+": |(read|write|dial|lookup) +|net\/http: |(unexpected )?eof[[:space:]]*$)/
      if (network && line ~ /(^|: )(connection reset( by peer)?|i\/o timeout|tls handshake timeout|no such host|(unexpected )?eof|connection refused)[[:space:]]*$/) found=1
    }
    END { exit !found }
  ' "$scratch/trace"; then
    # POST queries and clobber uploads retain their HTTP-status policy, but
    # a missing response can hide a completed write; never replay it.
    failure="transport error"
    transient=true
  fi
  echo "GitHub command failed: $failure, attempt $attempt/4 (exit $status)" >&2
  if [[ "$retryable" != true || "$transient" != true ]] || ((attempt == 4)); then
    # Traces are never forwarded: URLs, request bodies and even native error
    # messages can contain credentials. Exit codes and status remain observable.
    exit "$status"
  fi
  delay=$((2 ** (attempt - 1) + RANDOM % 3))
  ((retry_after <= delay)) || delay=$retry_after
  if ((SECONDS - started + delay >= 60)); then
    echo 'GitHub retry budget exhausted' >&2
    exit "$status"
  fi
  echo "Retrying GitHub $failure after attempt $attempt/4 in ${delay}s" >&2
  sleep "$delay"
done
