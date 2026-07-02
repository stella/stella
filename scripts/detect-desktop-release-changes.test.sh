#!/usr/bin/env bash
#
# Tests for scripts/detect-desktop-release-changes.sh.
#
# The script under test shells out to `git` (tags + diff) and `gh`
# (release asset lookup), so each case builds a throwaway git repo in
# a temp dir with a hand-crafted tag/commit topology, and a stub `gh`
# on PATH that answers "does this tag's release carry latest.json?"
# from a per-case env var. Commit + tag object dates are stamped with
# strictly increasing timestamps so `git tag --sort=-creatordate` is
# deterministic across platforms.
#
# The real scripts/release-channel.sh is used unchanged: the script
# resolves it relative to its own path, so pointing $SCRIPT at the
# real file picks up the real channel logic automatically.
#
# Covers:
#   1. First release of a channel (no prior manifest) → build, empty
#      previous_tag.
#   2. Stable, a desktop file changed since the previous stable →
#      build (and asserts gh was invoked as `release view`).
#   3. Stable, only backend paths + VERSION changed → skip.
#   4. Channel isolation: a newer rc with a manifest sits between two
#      stables; the stable still diffs against the previous STABLE.
#   5. Prerelease channel-exact: an rc diffs against the last rc,
#      ignoring a newer beta that has a manifest (and skips cleanly).
#   6. Change under packages/ui/ (the desktop's only workspace dep) →
#      build.
#   7. Change to .github/workflows/release-desktop.yml → build.
#   8. A prior tag whose release has no manifest (stub gh exits 1) is
#      skipped over during the search for a comparison point.
#
# Run locally:    bash scripts/detect-desktop-release-changes.test.sh
# Wired into CI in .github/workflows/ci.yml and scripts/verify.sh.
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/detect-desktop-release-changes.sh"

WORK="$(mktemp -d)"
STUB_BIN="$WORK/bin"
GH_CALL_LOG="$WORK/gh-calls.log"
mkdir -p "$STUB_BIN"
: > "$GH_CALL_LOG"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# --- stub gh: only `gh release view <tag> --json assets --jq ...` ---
# Prints a `latest.json` asset line and exits 0 for any tag listed in
# GH_TAGS_WITH_MANIFEST (space separated); exits 1 otherwise, matching
# real gh for a release without that asset (or no release at all). Any
# other invocation is a bug in the script under test: fail loudly.
cat > "$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -u
if [[ "${1:-}" != "release" || "${2:-}" != "view" ]]; then
  echo "gh stub: unexpected invocation: $*" >&2
  exit 3
fi
tag="${3:-}"
[[ -n "${GH_CALL_LOG:-}" ]] && echo "release view $tag" >> "$GH_CALL_LOG"
for t in ${GH_TAGS_WITH_MANIFEST:-}; do
  if [[ "$t" == "$tag" ]]; then
    echo "latest.json"
    exit 0
  fi
done
exit 1
STUB
chmod +x "$STUB_BIN/gh"

PASS=0
FAIL=0
FAIL_NAMES=()

# Monotonic clock for git object dates. Advance before every commit
# and every annotated tag so creation order is unambiguous.
TS=1000000000
next_ts() {
  TS=$((TS + 100))
  export GIT_AUTHOR_DATE="$TS +0000"
  export GIT_COMMITTER_DATE="$TS +0000"
}

new_repo() {
  # Echoes the path of a fresh initialised repo under $WORK.
  local dir="$WORK/repo-$1"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" config user.name "Test"
  git -C "$dir" config user.email "test@example.com"
  git -C "$dir" config commit.gpgsign false
  git -C "$dir" config tag.gpgsign false
  echo "$dir"
}

commit_touching() {
  local dir="$1" path="$2" msg="$3"
  mkdir -p "$dir/$(dirname "$path")"
  echo "$msg" >> "$dir/$path"
  git -C "$dir" add "$path" >/dev/null
  next_ts
  git -C "$dir" commit -q -m "$msg"
}

tag_annotated() {
  local dir="$1" name="$2"
  next_ts
  git -C "$dir" tag -a "$name" -m "$name"
}

# Runs the script inside $dir with a stubbed gh + manifest set, then
# asserts the emitted should_build / previous_tag lines.
expect_case() {
  local name="$1" dir="$2" tag="$3" manifests="$4"
  local want_build="$5" want_prev="$6"
  local out got_build got_prev

  out="$(
    cd "$dir" \
      && PATH="$STUB_BIN:$PATH" \
         GH_TOKEN="stub" \
         GH_CALL_LOG="$GH_CALL_LOG" \
         GH_TAGS_WITH_MANIFEST="$manifests" \
         bash "$SCRIPT" "$tag" 2>/dev/null
  )"

  got_build="$(printf '%s\n' "$out" | grep '^should_build=' | head -n1)"
  got_build="${got_build#should_build=}"
  got_prev="$(printf '%s\n' "$out" | grep '^previous_tag=' | head -n1)"
  got_prev="${got_prev#previous_tag=}"

  if [[ "$got_build" != "$want_build" || "$got_prev" != "$want_prev" ]]; then
    FAIL=$((FAIL + 1))
    FAIL_NAMES+=("$name")
    printf '  x  %s\n     want should_build=%s previous_tag=%q\n     got  should_build=%s previous_tag=%q\n' \
      "$name" "$want_build" "$want_prev" "$got_build" "$got_prev"
    return
  fi
  PASS=$((PASS + 1))
  printf '  ok %s\n' "$name"
}

echo "Running detect-desktop-release-changes.sh tests..."

# 1. First release of a channel: only tag exists, nothing has a
#    manifest → build with empty previous_tag.
d="$(new_repo case1)"
commit_touching "$d" "apps/desktop/app.ts" "desktop init"
tag_annotated "$d" "v0.1.0"
expect_case "first release of a channel builds" \
  "$d" "v0.1.0" "" "true" ""

# 2. Stable with a desktop change since the previous stable → build.
d="$(new_repo case2)"
commit_touching "$d" "apps/desktop/a.ts" "desktop a"
tag_annotated "$d" "v0.1.0"
commit_touching "$d" "apps/desktop/b.ts" "desktop b"
tag_annotated "$d" "v0.2.0"
expect_case "stable + desktop change builds" \
  "$d" "v0.2.0" "v0.1.0" "true" "v0.1.0"

# The above case exercises the gh lookup: confirm the stub saw a
# `release view` call, i.e. the script really consults release assets.
if grep -q '^release view ' "$GH_CALL_LOG"; then
  PASS=$((PASS + 1))
  printf '  ok gh release view was invoked\n'
else
  FAIL=$((FAIL + 1))
  FAIL_NAMES+=("gh release view was invoked")
  printf '  x  gh release view was never invoked\n'
fi

# 3. Stable, only backend + VERSION changed → skip.
d="$(new_repo case3)"
commit_touching "$d" "apps/desktop/a.ts" "desktop a"
tag_annotated "$d" "v0.1.0"
commit_touching "$d" "apps/api/x.ts" "backend x"
commit_touching "$d" "VERSION" "0.2.0"
tag_annotated "$d" "v0.2.0"
expect_case "stable + backend/VERSION only skips" \
  "$d" "v0.2.0" "v0.1.0" "false" "v0.1.0"

# 4. Channel isolation: a newer rc (with a manifest) sits between two
#    stables. The current stable must select the previous STABLE, not
#    the rc. Picking the rc would diff rc.1..v0.2.0 (backend only →
#    skip); picking v0.1.0 catches the rc's desktop change → build.
d="$(new_repo case4)"
commit_touching "$d" "apps/desktop/a.ts" "desktop a"
tag_annotated "$d" "v0.1.0"
commit_touching "$d" "apps/desktop/b.ts" "desktop b on rc"
tag_annotated "$d" "v0.2.0-rc.1"
commit_touching "$d" "apps/api/x.ts" "backend x"
commit_touching "$d" "VERSION" "0.2.0"
tag_annotated "$d" "v0.2.0"
expect_case "stable ignores newer rc, diffs previous stable" \
  "$d" "v0.2.0" "v0.1.0 v0.2.0-rc.1" "true" "v0.1.0"

# 5. Prerelease channel-exact: current rc.2 must diff against rc.1,
#    not the newer beta.1 that also has a manifest. Both candidate
#    diffs here are backend-only, so the answer is skip either way;
#    previous_tag proves the rc-vs-beta discrimination.
d="$(new_repo case5)"
commit_touching "$d" "apps/desktop/a.ts" "desktop a"
tag_annotated "$d" "v0.2.0-rc.1"
commit_touching "$d" "apps/api/y.ts" "backend y on beta"
tag_annotated "$d" "v0.2.0-beta.1"
commit_touching "$d" "apps/api/x.ts" "backend x"
commit_touching "$d" "VERSION" "0.2.0-rc.2"
tag_annotated "$d" "v0.2.0-rc.2"
expect_case "rc diffs last rc, not newer beta" \
  "$d" "v0.2.0-rc.2" "v0.2.0-rc.1 v0.2.0-beta.1" "false" "v0.2.0-rc.1"

# 6. Change under packages/ui/ (desktop's only workspace dep) → build.
d="$(new_repo case6)"
commit_touching "$d" "apps/desktop/a.ts" "desktop a"
tag_annotated "$d" "v0.1.0"
commit_touching "$d" "packages/ui/src/button.tsx" "ui change"
tag_annotated "$d" "v0.2.0"
expect_case "packages/ui change builds" \
  "$d" "v0.2.0" "v0.1.0" "true" "v0.1.0"

# 7. Change to the release-desktop workflow itself → build.
d="$(new_repo case7)"
commit_touching "$d" "apps/desktop/a.ts" "desktop a"
tag_annotated "$d" "v0.1.0"
commit_touching "$d" ".github/workflows/release-desktop.yml" "workflow tweak"
tag_annotated "$d" "v0.2.0"
expect_case "release-desktop.yml change builds" \
  "$d" "v0.2.0" "v0.1.0" "true" "v0.1.0"

# 8. A prior tag whose release has NO manifest (stub gh exits 1) must
#    be skipped over: v0.2.0 has no manifest, so v0.3.0 compares back
#    to v0.1.0. The unshipped desktop change from v0.2.0 is therefore
#    (correctly) still pending → build.
d="$(new_repo case8)"
commit_touching "$d" "apps/desktop/a.ts" "desktop a"
tag_annotated "$d" "v0.1.0"
commit_touching "$d" "apps/desktop/b.ts" "desktop b (never shipped)"
tag_annotated "$d" "v0.2.0"
commit_touching "$d" "apps/api/x.ts" "backend x"
commit_touching "$d" "VERSION" "0.3.0"
tag_annotated "$d" "v0.3.0"
expect_case "skips a prior tag without a manifest" \
  "$d" "v0.3.0" "v0.1.0" "true" "v0.1.0"

# 9. Non-ancestor tags are ignored: a NEWER tag (with a manifest) that
#    is a descendant of the current tag must not be selected as the
#    comparison point (a retried run for an older tag would otherwise
#    diff forward). v0.3.0 sits on top of v0.2.0; running for v0.2.0
#    must still compare back to v0.1.0.
d="$(new_repo case9)"
commit_touching "$d" "apps/desktop/a.ts" "desktop a"
tag_annotated "$d" "v0.1.0"
commit_touching "$d" "apps/api/x.ts" "backend x"
tag_annotated "$d" "v0.2.0"
commit_touching "$d" "apps/desktop/b.ts" "desktop b"
tag_annotated "$d" "v0.3.0"
expect_case "ignores a newer non-ancestor tag" \
  "$d" "v0.2.0" "v0.1.0 v0.3.0" "false" "v0.1.0"

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -ne 0 ]]; then
  printf 'Failed cases:\n'
  printf '  - %s\n' "${FAIL_NAMES[@]}"
  exit 1
fi
