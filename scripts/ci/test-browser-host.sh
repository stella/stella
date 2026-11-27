#!/usr/bin/env bash
set -eo pipefail
command -v dbus-run-session
dbus-run-session -- xvfb-run -a bun test packages/agent-engine/src/sidecar/browser/hosts.e2e.test.ts
