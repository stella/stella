#!/usr/bin/env bash
set -euo pipefail

# Fetches the base images the given Dockerfiles build FROM through retry.sh, so
# a transient registry failure is retried before the build needs them.
#
#   pull-base-images.sh <Dockerfile>...
#     Pulls into the local image store, which `docker build` on the default
#     builder reads. `$BUILDPLATFORM` and `$TARGETPLATFORM` stages pull the
#     native platform, as that build resolves them.
#   pull-base-images.sh --buildx <platforms> <Dockerfile>...
#     Resolves each image in the active buildx builder for the build's target
#     platforms. A docker-container builder cannot read the local image store,
#     and BuildKit reuses a resolved manifest only for a digest reference, so
#     this mode requires every base image to be pinned by digest.
#
# Stage aliases and `scratch` are skipped; `$NAME` in a FROM line resolves from
# the Dockerfile's global ARG defaults.
#
# Keep this bash 3.2 compatible (no mapfile, no associative arrays).

retry="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/retry.sh"

usage() {
  echo "usage: pull-base-images.sh [--buildx <platforms>] <Dockerfile>..." >&2
  exit 2
}

buildx_platforms=""
if [[ "${1:-}" == "--buildx" ]]; then
  if [[ $# -lt 2 || -z "$2" ]]; then
    usage
  fi
  buildx_platforms="$2"
  shift 2
fi
if [[ $# -eq 0 ]]; then
  usage
fi

dockerfile=""
fail() {
  echo "pull-base-images.sh: ${dockerfile}: $*" >&2
  exit 1
}

arg_names=()
arg_values=()
stages=()
pull_platforms=()
pull_images=()

looked_up=""
lookup_arg() {
  local i
  for ((i = ${#arg_names[@]} - 1; i >= 0; i -= 1)); do
    if [[ "${arg_names[i]}" == "$1" ]]; then
      looked_up="${arg_values[i]}"
      return 0
    fi
  done
  fail "\$$1 has no global ARG default"
}

# Substitutes left to right without rescanning substituted text, so a value
# that itself contains `$` cannot loop.
expanded=""
expand_args() {
  local rest="$1" out=""
  # shellcheck disable=SC2016 # a literal `$` in the pattern
  local pattern='^([^$]*)\$(\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))(.*)$'
  while [[ "$rest" =~ $pattern ]]; do
    out+="${BASH_REMATCH[1]}"
    rest="${BASH_REMATCH[5]}"
    lookup_arg "${BASH_REMATCH[3]}${BASH_REMATCH[4]}"
    out+="$looked_up"
  done
  expanded="$out$rest"
}

unquote() {
  local value="$1"
  if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$value"
}

lowercase() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

is_stage() {
  local name i
  name="$(lowercase "$1")"
  for ((i = 0; i < ${#stages[@]}; i += 1)); do
    if [[ "${stages[i]}" == "$name" ]]; then
      return 0
    fi
  done
  return 1
}

add_pull() {
  local i
  for ((i = 0; i < ${#pull_images[@]}; i += 1)); do
    if [[ "${pull_platforms[i]}" == "$1" && "${pull_images[i]}" == "$2" ]]; then
      return
    fi
  done
  pull_platforms+=("$1")
  pull_images+=("$2")
}

parse_arg() {
  local word name
  for word in "$@"; do
    name="${word%%=*}"
    if [[ ! "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      fail "unsupported ARG: $word"
    fi
    # An ARG without a default stays undeclared: a FROM that uses it fails.
    if [[ "$word" != *=* ]]; then
      continue
    fi
    expand_args "$(unquote "${word#*=}")"
    arg_names+=("$name")
    arg_values+=("$expanded")
  done
}

parse_from() {
  local platform="" image="" alias=""
  while [[ $# -gt 0 && "$1" == --* ]]; do
    if [[ "$1" != --platform=* ]]; then
      fail "unsupported FROM flag: $1"
    fi
    platform="${1#--platform=}"
    shift
  done
  if [[ $# -eq 0 ]]; then
    fail "FROM without an image"
  fi
  image="$1"
  shift
  if [[ $# -eq 2 && "$(lowercase "$1")" == "as" ]]; then
    alias="$2"
  elif [[ $# -ne 0 ]]; then
    fail "unsupported FROM syntax: $image $*"
  fi

  expand_args "$image"
  image="$expanded"
  if [[ "$image" == *'$'* ]]; then
    fail "unresolved variable in FROM image: $image"
  fi

  if [[ "$(lowercase "$image")" != "scratch" ]] && ! is_stage "$image"; then
    # shellcheck disable=SC2016 # literal Dockerfile variable references
    case "$platform" in
      '$TARGETPLATFORM' | '${TARGETPLATFORM}')
        # The default: the build's target, native for a plain docker build.
        platform=""
        ;;
      '$BUILDPLATFORM' | '${BUILDPLATFORM}')
        # BuildKit resolves this per build; a plain docker build is native.
        if [[ -z "$buildx_platforms" ]]; then
          platform=""
        fi
        ;;
      *)
        expand_args "$platform"
        platform="$expanded"
        ;;
    esac
    if [[ -n "$buildx_platforms" && "$image" != *@sha256:* ]]; then
      fail "--buildx needs a digest-pinned base image: $image"
    fi
    add_pull "$platform" "$image"
  fi

  if [[ -n "$alias" ]]; then
    stages+=("$(lowercase "$alias")")
  fi
}

parse_instruction() {
  local words=()
  read -ra words <<<"$1"
  if ((${#words[@]} == 0)); then
    return
  fi
  local keyword
  keyword="$(lowercase "${words[0]}")"
  if [[ "$keyword" == "from" ]]; then
    seen_from=true
    parse_from "${words[@]:1}"
  elif [[ "$keyword" == "arg" && "$seen_from" == false ]]; then
    parse_arg "${words[@]:1}"
  fi
}

for dockerfile in "$@"; do
  if [[ ! -f "$dockerfile" ]]; then
    fail "no such file"
  fi
  # Stage names and global ARGs are scoped to one Dockerfile.
  arg_names=()
  arg_values=()
  stages=()
  seen_from=false
  instruction=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    # Comment lines may sit inside a continued instruction; skip them.
    if [[ "$line" == "#"* ]]; then
      continue
    fi
    if [[ "$line" == *\\ ]]; then
      instruction+="${line%\\} "
      continue
    fi
    parse_instruction "$instruction$line"
    instruction=""
  done <"$dockerfile"
  parse_instruction "$instruction"
done

if ((${#pull_images[@]} == 0)); then
  exit 0
fi

if [[ -z "$buildx_platforms" ]]; then
  for ((i = 0; i < ${#pull_images[@]}; i += 1)); do
    if [[ -n "${pull_platforms[i]}" ]]; then
      bash "$retry" docker pull --quiet --platform "${pull_platforms[i]}" "${pull_images[i]}"
    else
      bash "$retry" docker pull --quiet "${pull_images[i]}"
    fi
  done
  exit 0
fi

context="$(mktemp -d "${TMPDIR:-/tmp}/pull-base-images.XXXXXX")"
trap 'rm -rf "$context"' EXIT
for ((i = 0; i < ${#pull_images[@]}; i += 1)); do
  printf 'FROM %s%s\n' "${pull_platforms[i]:+--platform=${pull_platforms[i]} }" "${pull_images[i]}" \
    >"$context/Dockerfile"
  bash "$retry" docker buildx build --platform "$buildx_platforms" \
    --output type=cacheonly --file "$context/Dockerfile" "$context"
done
