#!/usr/bin/env bash
# Proof chaining for main/heavy. A release commit B may carry heavy evidence
# that ran only the jobs the diff A..B affects, when A is a fully proven
# ancestor on main: proof(B) = full heavy proof(A) + affected(A..B) passed on
# B. The jobs the diff does not affect are carried over from A.
#
# --select REPO B          Print the nearest anchor A for B, or nothing when B
#                          needs a full run. Read-only; used by main-heavy.yml
#                          from trusted main tooling before it plans B.
# --verify REPO B A W      Exit 0 only if the chain from A to B holds and the
#                          heavy run's workflow revision W is on main. Used by
#                          check-release-main-health.sh for a chained status.
# --forced-full A B        Print every changed path that forces a full run.
#
# Fail closed: an unreadable status, run or history, an anchor that is itself
# chained or red, any change to workflows, the planner, lockfiles, manifests,
# toolchains, base images, migrations or submodules, and anything else this
# script cannot prove all mean a full run (--select prints nothing) or a
# refused chain (--verify exits non-zero). Output for humans goes to stderr.
set -euo pipefail
export GIT_NO_REPLACE_OBJECTS=1

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
gh_retry_script="${GH_RETRY_SCRIPT:-$script_dir/gh-retry.sh}"

# How far back main's first-parent chain --select looks for an anchor. The
# scheduled main-heavy runs prove main tips hourly.
max_anchor_distance=50

# Only main/heavy chains, so the anchor must carry a full (unchained) trusted
# main/heavy success on the commit itself. main/pr-depth and staging/verified
# are never carried: the release gate requires both on B itself. The anchor
# may still not be red: its newest status in any release context must be a
# success or absent. (The scheduled heavy and PR-depth runs prove different
# main tips, so requiring both here would leave almost no anchors.)
anchor_contexts=(main/heavy)
anchor_never_red_contexts=(main/heavy main/pr-depth staging/verified)

# Changed paths that make affected-job planning untrustworthy. Bash [[ == ]]
# patterns: `*` also matches `/`. Over-approximate on purpose: the planner and
# everything it imports live under scripts/, so any change there runs full.
forced_full_patterns=(
  # Workflows, composite actions and CI policy data.
  '.github/*'
  # The planner, its import closure, and the release gates themselves.
  'scripts/*'
  'packages/scripts/*'
  # Lockfiles.
  '*.lock' '*.lockb' '*-lock.json' '*-lock.yaml' '*.lock.json' 'go.sum' '*/go.sum'
  # Dependency manifests and toolchains.
  'package.json' '*/package.json' 'bunfig.toml' '*/bunfig.toml' '.npmrc' '*/.npmrc'
  'bun-toolchain.json' 'stll-toolchain.json' '.node-version' '*/.node-version'
  '.nvmrc' '*/.nvmrc' '.tool-versions' '*/.tool-versions'
  'rust-toolchain' '*/rust-toolchain' 'rust-toolchain.toml' '*/rust-toolchain.toml'
  'Cargo.toml' '*/Cargo.toml' 'pyproject.toml' '*/pyproject.toml'
  'requirements*.txt' '*/requirements*.txt' 'turbo.json' 'tsconfig*.json' 'patches/*'
  # Base images and service containers.
  'Dockerfile' '*/Dockerfile' '*Dockerfile.*' '*.Dockerfile' '.dockerignore' '*/.dockerignore'
  'docker/*' 'docker-compose*' 'deploy/*' 'railway/*'
  # Database migrations.
  '*/drizzle/*' 'drizzle/*' '*/migrations/*' 'migrations/*' '*.sql' '*drizzle.config.*'
  # Submodule wiring.
  '.gitmodules'
)

is_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
is_repo() { [[ "$1" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; }

# Prints each changed path between two commits that forces a full run. Exits
# non-zero when the diff cannot be read, so callers never read "no paths" from
# a failed git call. Paths are read NUL-separated, so no file name can split.
forced_full_paths() {
  local from="$1" to="$2" file pattern raw
  raw=$(git diff --raw --no-renames "$from" "$to") || return 1
  # A gitlink (mode 160000) is a submodule pointer the planner cannot scope.
  if grep -Eq '^:(160000 [0-7]{6}|[0-7]{6} 160000) ' <<< "$raw"; then
    echo 'submodule pointer change'
  fi
  while IFS= read -r -d '' file; do
    for pattern in "${forced_full_patterns[@]}"; do
      # shellcheck disable=SC2053 # The pattern is a glob on purpose.
      if [[ "$file" == $pattern ]]; then
        printf '%s\n' "$file"
        break
      fi
    done
  done < <(git diff --name-only --no-renames -z "$from" "$to")
}

# Exit 0 only when the anchor is not red in any release context and every
# anchor context is a trusted, completed, unchained success from its own
# workflow on main, bound to this commit.
anchor_proven() {
  local repo="$1" anchor="$2" statuses context workflow title status url run_id run
  statuses=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/commits/$anchor/statuses?per_page=100") || return 1
  for context in "${anchor_never_red_contexts[@]}"; do
    jq -e --arg context "$context" '
      ([.[][] | select(.context == $context)][0].state // "missing") as $state |
      $state == "missing" or $state == "success"
    ' <<< "$statuses" >/dev/null || { echo "Anchor $anchor has a non-green $context." >&2; return 1; }
  done
  for context in "${anchor_contexts[@]}"; do
    case "$context" in
      main/heavy) workflow=.github/workflows/main-heavy.yml title='Main heavy suites ' ;;
      main/pr-depth) workflow=.github/workflows/main-pr-depth.yml title='Main PR-depth checks ' ;;
      *) return 1 ;;
    esac
    # Statuses arrive newest first, so a later failure replaces a success.
    status=$(jq -ce --arg context "$context" '[.[][] | select(.context == $context)][0] // error("missing")' <<< "$statuses" 2>/dev/null) || {
      echo "Anchor $anchor has no $context." >&2; return 1;
    }
    jq -e '.state == "success" and .creator.login == "github-actions[bot]" and .creator.type == "Bot" and
      (.description | type) == "string" and (.description | contains("chain=") | not)' <<< "$status" >/dev/null || {
      echo "Anchor $anchor has no trusted, unchained $context success." >&2; return 1;
    }
    url=$(jq -r '.target_url // ""' <<< "$status")
    [[ "$url" == "https://github.com/$repo/actions/runs/"* ]] || return 1
    run_id="${url#"https://github.com/$repo/actions/runs/"}"
    [[ "$run_id" =~ ^[1-9][0-9]*$ ]] || return 1
    run=$(bash "$gh_retry_script" api "repos/$repo/actions/runs/$run_id") || return 1
    jq -e --arg repo "$repo" --arg sha "$anchor" --arg url "$url" --arg workflow "$workflow" --arg title "$title" --argjson id "$run_id" '
      .id == $id and .html_url == $url and .repository.full_name == $repo and
      .path == $workflow and .head_branch == "main" and
      (.event == "push" or .event == "workflow_dispatch" or .event == "schedule") and
      .display_title == ($title + $sha) and
      (.event == "workflow_dispatch" or .head_sha == $sha) and
      .status == "completed" and .conclusion == "success"
    ' <<< "$run" >/dev/null || { echo "Anchor $anchor $context run $run_id does not match." >&2; return 1; }
  done
}

on_main() {
  local commit="$1" history
  history=$(git rev-list --first-parent "$(git rev-parse --verify 'origin/main^{commit}')") || return 1
  [[ $'\n'"$history"$'\n' == *$'\n'"$commit"$'\n'* ]]
}

mode="${1:-}"
case "$mode" in
  --forced-full)
    from="${2:?ancestor SHA is required}"
    to="${3:?target SHA is required}"
    is_sha "$from" && is_sha "$to" || { echo 'invalid SHA' >&2; exit 1; }
    forced_full_paths "$from" "$to"
    ;;
  --select)
    repo="${2:?repository is required}"
    target="${3:?target SHA is required}"
    is_repo "$repo" && is_sha "$target" || { echo 'PROOF_CHAIN_FULL: invalid repository or SHA' >&2; exit 0; }
    main=$(git rev-parse --verify 'origin/main^{commit}' 2>/dev/null) || { echo 'PROOF_CHAIN_FULL: main is unavailable' >&2; exit 0; }
    start=$(git merge-base "$target" "$main" 2>/dev/null) || { echo "PROOF_CHAIN_FULL: $target shares no history with main" >&2; exit 0; }
    candidates=$(git rev-list --first-parent -n "$max_anchor_distance" "$start") || exit 0
    while IFS= read -r candidate; do
      [[ -n "$candidate" && "$candidate" != "$target" ]] || continue
      anchor_proven "$repo" "$candidate" 2>/dev/null || continue
      # The nearest proven anchor decides: an older one only adds changes.
      if ! forced=$(forced_full_paths "$candidate" "$target"); then
        echo "PROOF_CHAIN_FULL: the diff from $candidate is unreadable" >&2
        exit 0
      fi
      if [[ -n "$forced" ]]; then
        echo "PROOF_CHAIN_FULL: changes since anchor $candidate force a full run:" >&2
        sed 's/^/  /' <<< "$forced" >&2
        exit 0
      fi
      echo "Proof chain: $target plans against fully proven anchor $candidate." >&2
      printf '%s\n' "$candidate"
      exit 0
    done <<< "$candidates"
    echo "PROOF_CHAIN_FULL: no fully proven anchor within $max_anchor_distance main commits" >&2
    ;;
  --verify)
    repo="${2:?repository is required}"
    target="${3:?target SHA is required}"
    anchor="${4:?anchor SHA is required}"
    workflow_revision="${5:?workflow revision is required}"
    refuse() { echo "PROOF_CHAIN_REFUSED: $1" >&2; exit 1; }
    is_repo "$repo" && is_sha "$target" && is_sha "$anchor" && is_sha "$workflow_revision" || refuse 'invalid repository or SHA'
    [[ "$anchor" != "$target" ]] || refuse 'a commit cannot anchor itself'
    git cat-file -e "$anchor^{commit}" 2>/dev/null || refuse "anchor $anchor is not in main's history"
    git cat-file -e "$target^{commit}" 2>/dev/null || refuse "target $target is unavailable"
    on_main "$anchor" || refuse "anchor $anchor is not on main's first-parent history"
    # Local refs alone are insufficient: confirm with the repository itself.
    comparison=$(bash "$gh_retry_script" api "repos/$repo/compare/$anchor...main") || refuse 'main comparison is unavailable'
    jq -e --arg sha "$anchor" '(.status == "ahead" or .status == "identical") and .merge_base_commit.sha == $sha' <<< "$comparison" >/dev/null \
      || refuse "anchor $anchor is not on repository main"
    git merge-base --is-ancestor "$anchor" "$target" || refuse "anchor $anchor is not an ancestor of $target"
    # The plan ran from trusted main workflow code, never a branch revision.
    on_main "$workflow_revision" || refuse "workflow revision $workflow_revision is not on main"
    forced=$(forced_full_paths "$anchor" "$target") || refuse "the diff from $anchor is unreadable"
    [[ -z "$forced" ]] || refuse "changes since $anchor require a full run: $(tr '\n' ' ' <<< "$forced")"
    anchor_proven "$repo" "$anchor" || refuse "anchor $anchor is not fully proven"
    echo "Proof chain holds: $target carries unaffected heavy jobs from $anchor." >&2
    ;;
  *)
    echo 'usage: release-proof-chain.sh --select REPO B | --verify REPO B A W | --forced-full A B' >&2
    exit 2
    ;;
esac
