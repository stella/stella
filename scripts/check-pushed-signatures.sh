#!/usr/bin/env bash
# Refuse a push that would publish an unsigned commit, or one signed by a key
# GitHub does not know. The main branch accepts only verified commits, and a
# pull request carrying an unverified one reports every check green while it
# can never merge, so the push is the place to say so. Runs from the pre-push
# hook, which hands every ref update on stdin as
# `<local-ref> <local-oid> <remote-ref> <remote-oid>`. Commits on a
# remote-tracking ref are already published, so a branch that merged main
# checks its own commits, not main's.
#
# A signed commit must be signed by a key on the GitHub account `gh` is signed
# in as: its SSH signing keys or its GPG keys, read from GitHub's public key
# listings. SIGNING_KEYS_DIR names a directory holding `ssh` (one public key
# per line) and `gpg` (one key ID per line) instead. Without either source the
# key check is skipped with a note; the merge queue still refuses the commit.
set -euo pipefail

zero_oid="0000000000000000000000000000000000000000"
unsigned=()
unknown_key=()

if [[ -t 0 ]]; then
  echo "signatures: run from the pre-push hook, which supplies the ref updates." >&2
  exit 0
fi

gh_retry_script="${GH_RETRY_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/gh-retry.sh}"
work=$(mktemp -d)
trap 'rm -rf "${work}"' EXIT

# The keys GitHub verifies against, as an allowed-signers file and a key ID
# list. Returns 1 when they cannot be read.
load_registered_keys() {
  local ssh_keys gpg_ids
  if [[ -n "${SIGNING_KEYS_DIR:-}" ]]; then
    ssh_keys=$(cat "${SIGNING_KEYS_DIR}/ssh" 2>/dev/null || true)
    gpg_ids=$(cat "${SIGNING_KEYS_DIR}/gpg" 2>/dev/null || true)
  else
    command -v gh >/dev/null 2>&1 || return 1
    local login
    login=$("${gh_retry_script}" api user --jq .login 2>/dev/null) || return 1
    [[ -n "${login}" ]] || return 1
    ssh_keys=$("${gh_retry_script}" api "users/${login}/ssh_signing_keys" --jq '.[].key' 2>/dev/null) || return 1
    gpg_ids=$("${gh_retry_script}" api "users/${login}/gpg_keys" --jq '.[] | .key_id, .subkeys[].key_id' 2>/dev/null) || return 1
  fi
  : > "${work}/allowed_signers"
  while read -r key; do
    [[ -z "${key}" ]] && continue
    printf '* namespaces="git" %s\n' "${key}" >> "${work}/allowed_signers"
  done <<< "${ssh_keys}"
  tr '[:lower:]' '[:upper:]' <<< "${gpg_ids}" | sed '/^$/d' > "${work}/gpg_ids"
}

keys_loaded=unknown
# Whether `commit`'s signature is by a registered key.
signed_by_registered_key() {
  local commit=$1
  if [[ "${keys_loaded}" == unknown ]]; then
    if load_registered_keys; then keys_loaded=yes; else keys_loaded=no; fi
  fi
  [[ "${keys_loaded}" == no ]] && return 0
  if git cat-file commit "${commit}" | awk '/^$/ { exit 1 } /^gpgsig(-sha256)? -----BEGIN SSH SIGNATURE-----/ { found = 1; exit 0 } END { exit !found }'; then
    git -c gpg.ssh.allowedSignersFile="${work}/allowed_signers" \
      verify-commit "${commit}" >/dev/null 2>&1
    return
  fi
  local key_id
  key_id=$(git log -n 1 --format=%GK "${commit}" 2>/dev/null | tr '[:lower:]' '[:upper:]')
  [[ -n "${key_id}" ]] && grep -qx -- "${key_id}" "${work}/gpg_ids"
}

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
    elif ! signed_by_registered_key "${commit}"; then
      unknown_key+=("${commit}")
    fi
  done < <(git rev-list "${range[@]}" --not --remotes)
done

if [[ "${keys_loaded}" == no ]]; then
  echo "signatures: could not read the signing keys on your GitHub account (gh); skipped the key check." >&2
fi

status=0
if [[ ${#unsigned[@]} -gt 0 ]]; then
  echo "error: the push would publish unsigned commits, which main never accepts:" >&2
  for commit in "${unsigned[@]}"; do
    git log -n 1 --format='  %h %s' "${commit}" >&2
  done
  echo "Sign them (commit.gpgsign) and rewrite those commits before pushing." >&2
  status=1
fi
if [[ ${#unknown_key[@]} -gt 0 ]]; then
  echo "error: the push would publish commits signed by a key your GitHub account does not list, which main never accepts:" >&2
  for commit in "${unknown_key[@]}"; do
    git log -n 1 --format='  %h %s' "${commit}" >&2
  done
  echo "Register the key as a signing key on GitHub, or set user.signingkey to a registered one, then rewrite those commits." >&2
  status=1
fi
exit "${status}"
