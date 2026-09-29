#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/pull-base-images.sh"
PASS=0
FAIL=0
FAIL_NAMES=()

BUN="oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61"
NODE="node:26-slim@sha256:65f816afd401c1c4de3293acc46dce115398152af4bdcd73c103b096988922d7"

setup_case() {
  dir=$(mktemp -d)
  mkdir -p "$dir/bin"
  # Logs every docker call; a buildx build also logs the Dockerfile it builds.
  cat >"$dir/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
count=0
if [[ -f "$FAKE_DIR/count" ]]; then
  count=$(<"$FAKE_DIR/count")
fi
count=$((count + 1))
printf '%s' "$count" >"$FAKE_DIR/count"
printf 'docker %s\n' "$*" >>"$FAKE_DIR/calls"
previous=""
for arg in "$@"; do
  if [[ "$previous" == "--file" ]]; then
    sed 's/^/  /' "$arg" >>"$FAKE_DIR/calls"
  fi
  previous="$arg"
done
if ((count <= ${FAKE_FAILURES:-0})); then
  exit 1
fi
EOF
  cat >"$dir/bin/sleep" <<'EOF'
#!/usr/bin/env bash
EOF
  chmod +x "$dir/bin/docker" "$dir/bin/sleep"
  export FAKE_DIR="$dir"
}

teardown_case() {
  rm -rf "$dir"
  unset dir FAKE_DIR FAKE_FAILURES
}

record() {
  local name="$1" ok="$2" detail="$3"
  if [[ "$ok" == true ]]; then
    PASS=$((PASS + 1))
    printf '  PASS  %s\n' "$name"
    return
  fi
  FAIL=$((FAIL + 1))
  FAIL_NAMES+=("$name")
  printf '  FAIL  %s\n' "$name"
  printf '       %s\n' "${detail//$'\n'/$'\n       '}"
}

# check <name> <expected exit> <expected calls> <Dockerfile content> [script args...]
# The Dockerfile path is appended to the script arguments.
check() {
  local name="$1" expected_exit="$2" expected_calls="$3" content="$4"
  shift 4
  setup_case
  printf '%s' "$content" >"$dir/Dockerfile"
  local output actual calls=""
  mkdir "$dir/tmp"
  output=$(PATH="$dir/bin:$PATH" TMPDIR="$dir/tmp" bash "$SCRIPT" "$@" "$dir/Dockerfile" 2>&1) \
    && actual=0 || actual=$?
  if [[ -f "$dir/calls" ]]; then
    calls=$(sed "s#$dir/tmp/[^/ ]*#<ctx>#g" "$dir/calls")
  fi
  if [[ "$actual" == "$expected_exit" && "$calls" == "$expected_calls" ]]; then
    record "$name" true ""
  else
    record "$name" false "exit $actual (expected $expected_exit)
calls:
$calls
expected:
$expected_calls
output:
$output"
  fi
  teardown_case
}

echo "Running pull-base-images.sh tests..."

check "pulls a multi-stage Dockerfile's base once and skips stage aliases" 0 \
  "docker pull --quiet $BUN" \
  "FROM $BUN AS base
FROM base AS deps
RUN true
FROM Deps AS builder
FROM builder
"

check "keeps digest pins and tags exactly as written" 0 \
  "docker pull --quiet $BUN
docker pull --quiet $NODE
docker pull --quiet alpine:3.20" \
  "FROM $BUN
FROM $NODE
FROM alpine:3.20
"

check "skips scratch" 0 \
  "docker pull --quiet $BUN" \
  "FROM scratch AS empty
FROM $BUN
FROM SCRATCH
"

check "pulls build and target platform stages natively, literal platforms as given" 0 \
  "docker pull --quiet $BUN
docker pull --quiet --platform linux/amd64 $BUN" \
  "FROM --platform=\$BUILDPLATFORM $BUN AS build-base
FROM --platform=\${TARGETPLATFORM} $BUN AS runtime-base
FROM --platform=linux/amd64 $BUN AS amd64
"

check "resolves global ARG defaults in images and platforms" 0 \
  "docker pull --quiet $BUN
docker pull --quiet --platform linux/arm64 node:26-slim" \
  "ARG BASE=$BUN
ARG NODE_TAG=\"26-slim\" ARCH=linux/arm64
ARG REPO=node
ARG NODE_IMAGE=\${REPO}:\$NODE_TAG
FROM \${BASE} AS base
FROM --platform=\$ARCH \$NODE_IMAGE
"

check "fails on an ARG with no default" 1 "" \
  "ARG BASE
FROM \$BASE
"

check "fails on an ARG declared after the first FROM" 1 "" \
  "FROM $BUN
ARG LATER=$NODE
FROM \$LATER
"

check "joins continued lines and skips comments" 0 \
  "docker pull --quiet --platform linux/amd64 $BUN" \
  "# syntax=docker/dockerfile:1
  # indented comment
FROM \\
  --platform=linux/amd64 \\
  # comment inside the instruction
  $BUN \\
  AS base
RUN echo FROM $NODE
"

check "fails on an unsupported FROM flag" 1 "" \
  "FROM --pull=always $BUN
"

FAKE_FAILURES=1 check "retries a failed pull" 0 \
  "docker pull --quiet $BUN
docker pull --quiet $BUN" \
  "FROM $BUN
"

check "resolves each base in the buildx builder for the target platforms" 0 \
  "docker buildx build --platform linux/arm64 --output type=cacheonly --file <ctx>/Dockerfile <ctx>
  FROM --platform=\$BUILDPLATFORM $BUN
docker buildx build --platform linux/arm64 --output type=cacheonly --file <ctx>/Dockerfile <ctx>
  FROM $BUN
docker buildx build --platform linux/arm64 --output type=cacheonly --file <ctx>/Dockerfile <ctx>
  FROM --platform=linux/amd64 $NODE" \
  "FROM --platform=\$BUILDPLATFORM $BUN AS build-base
FROM --platform=\$TARGETPLATFORM $BUN AS runtime-base
FROM --platform=linux/amd64 $NODE
FROM runtime-base
" --buildx linux/arm64

check "--buildx rejects a base image without a digest" 1 "" \
  "FROM $BUN
FROM alpine:3.20
" --buildx linux/amd64

check "rejects --buildx without platforms" 2 "" "FROM $BUN
" --buildx ""

setup_case
output=$(PATH="$dir/bin:$PATH" bash "$SCRIPT" 2>&1) && actual=0 || actual=$?
if [[ "$actual" == 2 ]]; then
  record "rejects a missing Dockerfile argument" true ""
else
  record "rejects a missing Dockerfile argument" false "exit $actual: $output"
fi
output=$(PATH="$dir/bin:$PATH" bash "$SCRIPT" "$dir/missing" 2>&1) && actual=0 || actual=$?
if [[ "$actual" == 1 ]]; then
  record "fails on a missing Dockerfile" true ""
else
  record "fails on a missing Dockerfile" false "exit $actual: $output"
fi
teardown_case

# Every Dockerfile in the repository parses, and the digest-pinned mode the
# release builds use accepts each one.
setup_case
dockerfiles=()
while IFS= read -r file; do
  dockerfiles+=("$file")
done < <(cd "$ROOT" && git ls-files '*Dockerfile' '*.Dockerfile')
output=$(cd "$ROOT" && PATH="$dir/bin:$PATH" bash "$SCRIPT" --buildx linux/arm64 "${dockerfiles[@]}" 2>&1) \
  && actual=0 || actual=$?
builds=$(grep -c '^docker buildx build' "$dir/calls" 2>/dev/null)
if [[ "$actual" == 0 && ${#dockerfiles[@]} -ge 3 && "$builds" -ge 1 ]]; then
  record "every repository Dockerfile resolves in buildx mode" true ""
else
  record "every repository Dockerfile resolves in buildx mode" false \
    "exit $actual, ${#dockerfiles[@]} Dockerfiles, $builds builds: $output"
fi
teardown_case

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -ne 0 ]]; then
  printf 'Failed cases:\n'
  printf '  - %s\n' "${FAIL_NAMES[@]}"
  exit 1
fi
