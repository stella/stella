#!/usr/bin/env bash
set -uo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
script="$script_dir/check-ai-skill-sync.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

missing_output="$(bash "$script" "$test_root")"
if [[ "$missing_output" != *"skipping the local AI skill sync check"* ]]; then
  echo "missing submodule was not skipped" >&2
  exit 1
fi

sync_dir="$test_root/.ai/shared/scripts"
mkdir -p "$sync_dir"
cat > "$sync_dir/sync-ai-skills.sh" <<STUB
#!/usr/bin/env bash
if [[ "\${1:-}" != "--check" || "\${2:-}" != "$test_root" ]]; then
  exit 9
fi
STUB

bash "$script" "$test_root"
echo "AI skill sync wrapper: all tests passed"
