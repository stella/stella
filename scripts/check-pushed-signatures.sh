#!/usr/bin/env bash
# Refuse a push that would publish an unsigned commit. The main branch accepts
# only signed commits, and a pull request carrying an unsigned one reports
# every check green while it can never merge, so the push is the place to say
# so. Runs from the pre-push hook, which hands every ref update on stdin as
# `<local-ref> <local-oid> <remote-ref> <remote-oid>`. Commits on a
# remote-tracking ref are already published, so a branch that merged main
# checks its own commits, not main's. A commit counts as signed when it
# carries a signature header; GitHub verifies the key.
set -euo pipefail

zero_oid="0000000000000000000000000000000000000000"
unsigned=()

if [[ -t 0 ]]; then
  echo "signatures: run from the pre-push hook, which supplies the ref updates." >&2
  exit 0
fi

while read -r local_ref local_oid remote_ref remote_oid; do
  [[ -z "${local_ref:-}" ]] && continue
  # Deleting a remote ref publishes no commits.
  [[ "${local_oid}" == "${zero_oid}" ]] && continue
  range=("${local_oid}")
  if [[ "${remote_oid}" != "${zero_oid}" ]] &&
    git cat-file -e "${remote_oid}^{commit}" 2>/dev/null; then
    range+=("^${remote_oid}")
  fi
  while read -r commit; do
    [[ -z "${commit}" ]] && continue
    # The header ends at the first blank line; the message cannot fake one.
    if ! git cat-file commit "${commit}" | awk '/^$/ { exit 1 } /^gpgsig(-sha256)? / { found = 1; exit 0 } END { exit !found }'; then
      unsigned+=("${commit}")
    fi
  done < <(git rev-list "${range[@]}" --not --remotes)
done

if [[ ${#unsigned[@]} -gt 0 ]]; then
  echo "error: the push would publish unsigned commits, which main never accepts:" >&2
  for commit in "${unsigned[@]}"; do
    git log -n 1 --format='  %h %s' "${commit}" >&2
  done
  echo "Sign them (commit.gpgsign) and rewrite those commits before pushing." >&2
  exit 1
fi
