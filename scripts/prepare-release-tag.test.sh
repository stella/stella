#!/usr/bin/env bash
# Exercise the real RC identity selector and its separate finalization gate.
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun test "$script_dir/release-rc-selection.test.ts"
