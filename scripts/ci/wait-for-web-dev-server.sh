#!/usr/bin/env bash
set -eo pipefail
for i in {1..60}; do
  if curl --connect-timeout 2 --max-time 5 -sf http://localhost:3000 > /dev/null 2>&1; then
    echo "Web up after ${i}s"
    exit 0
  fi
  sleep 1
done
echo "::error::Web never came up"
tail -200 /tmp/web.log || true
exit 1
