#!/usr/bin/env bash
set -eo pipefail
echo "::error::Network baseline failed. Fix unintended regressions; for intentional route changes, add the baseline:record label to this PR, then review the recorded budgets and resolve the recorder's review thread."
