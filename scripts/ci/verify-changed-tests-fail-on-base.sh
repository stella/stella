#!/usr/bin/env bash
set -eo pipefail
body_file="$RUNNER_TEMP/pull-request-body.md"
bash "$GH_RETRY_SCRIPT" api "repos/$REPO/pulls/$PR_NUMBER" --jq '.body // ""' > "$body_file"
# The checkout is the test merge: its first parent is the base.
bun scripts/fix-tests-on-base.ts --base HEAD^1 --title "$PR_TITLE" --body-file "$body_file"
