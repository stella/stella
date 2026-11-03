#!/usr/bin/env bash
# The release path is automatic; its App environment may only scope branches.
set -euo pipefail
repo="${1:?repository is required}"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || exit 2
gh_retry_script="${GH_RETRY_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/gh-retry.sh}"
environment=$(bash "$gh_retry_script" api "repos/$repo/environments/release-app")
jq -e '.deployment_branch_policy.custom_branch_policies == true and
  .deployment_branch_policy.protected_branches == false and
  all(.protection_rules[]; .type == "branch_policy")' <<< "$environment" >/dev/null || {
  echo '::error::release-app must retain only its branch policy; reviewer or approval waits block automatic releases' >&2
  exit 1
}
