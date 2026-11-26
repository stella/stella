#!/usr/bin/env bash
set -eo pipefail
if [[ -f /tmp/landing.pid ]]; then
  kill "$(cat /tmp/landing.pid)" || true
  rm -f /tmp/landing.pid
fi
