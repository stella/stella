#!/usr/bin/env bash
set -eo pipefail
cd apps/landing
nohup bun --bun astro preview --port 4321 > /tmp/landing.log 2>&1 &
echo $! > /tmp/landing.pid
