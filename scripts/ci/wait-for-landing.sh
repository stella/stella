#!/usr/bin/env bash
set -eo pipefail
for i in {1..60}; do
  if curl --connect-timeout 2 --max-time 5 -sf http://localhost:4321 > /dev/null 2>&1; then
    echo "Landing up after ${i}s"
    exit 0
  fi
  sleep 1
done
echo "::error::Landing preview never came up"
tail -200 /tmp/landing.log || true
exit 1
