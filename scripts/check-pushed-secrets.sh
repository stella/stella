#!/usr/bin/env bash
# Scan the commits a push would publish for secrets. Runs from the pre-push
# hook, which hands every ref update on stdin as
# `<local-ref> <local-oid> <remote-ref> <remote-oid>`; each pushed ref is
# scanned from what the remote already has to what it would receive, so an
# explicit refspec (`git push origin other:other`) is covered, not only HEAD.
# Everything else is validated in CI.
set -euo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "error: gitleaks is required for pre-push secret scanning." >&2
  echo "Install it from https://github.com/gitleaks/gitleaks/releases" >&2
  echo "  macOS (Homebrew): brew install gitleaks" >&2
  echo "  Other platforms: use the releases page above" >&2
  exit 1
fi

zero_oid="0000000000000000000000000000000000000000"
ranges=()
records=0

if [[ ! -t 0 ]]; then
  while read -r local_ref local_oid remote_ref remote_oid; do
    [[ -z "${local_ref:-}" ]] && continue
    records=$((records + 1))
    # Deleting a remote ref publishes no commits.
    [[ "${local_oid}" == "${zero_oid}" ]] && continue
    if [[ "${remote_oid}" == "${zero_oid}" ]] ||
      ! git cat-file -e "${remote_oid}^{commit}" 2>/dev/null; then
      # New remote ref, or a remote tip this clone has not fetched (gitleaks
      # reads an unknown range as zero commits and exits 0): everything not
      # already on any remote-tracking ref.
      ranges+=("${local_oid} --not --remotes")
    else
      ranges+=("${remote_oid}..${local_oid}")
    fi
  done
fi

if [[ ${records} -gt 0 && ${#ranges[@]} -eq 0 ]]; then
  echo "secrets: the push publishes no commits; nothing to scan." >&2
  exit 0
fi

# Run by hand (no hook records): scan the current branch against origin/main.
if [[ ${#ranges[@]} -eq 0 ]]; then
  if base="$(git merge-base origin/main HEAD 2>/dev/null)"; then
    ranges+=("${base}..HEAD")
  else
    ranges+=("HEAD")
  fi
fi

# A scanner can exit 0 when Git cannot resolve the commits it was asked to
# read, so every range must resolve before any scan result is trusted.
for range in "${ranges[@]}"; do
  read -r -a revisions <<<"${range}"
  if ! git rev-list "${revisions[@]}" >/dev/null 2>&1; then
    echo "error: cannot resolve pushed commit range ${range}; secret scanning refused." >&2
    exit 1
  fi
done

for range in "${ranges[@]}"; do
  gitleaks git --redact --no-banner --no-color --log-opts="${range}" .
done
