#!/usr/bin/env bash
# Reconcile durable publication receipts; report every missing artifact together.
set -euo pipefail
receipts="$1"
missing=0
for artifact in release :latest health-run production; do
  if ! jq -e --arg key "$artifact" '.[$key] == true' "$receipts" >/dev/null; then
    echo "::error::Missing release artifact: $artifact"
    missing=1
  fi
done
exit "$missing"
