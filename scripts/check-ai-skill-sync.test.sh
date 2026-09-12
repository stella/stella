#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
script="$script_dir/check-ai-skill-sync.sh"
source_check="$script_dir/check-ai-skill-sources.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

new_repo() {
  local fixture="$test_root/$1"
  git -c init.defaultBranch=main init -q "$fixture"
  git -C "$fixture" config user.name Fixture
  git -C "$fixture" config user.email fixture@example.test
  git -C "$fixture" config commit.gpgsign false
  git -C "$fixture" config core.hooksPath /dev/null
  mkdir -p "$fixture/.ai/local" "$fixture/apps/api" "$fixture/.agents/skills/example"
  printf '%s\n' 'Initial content' > "$fixture/README.md"
  printf '%s\n' 'Initial instructions' > "$fixture/.ai/local/agents.md"
  printf '%s\n' 'Initial instructions' > "$fixture/AGENTS.md"
  printf '%s\n' 'Initial instructions' > "$fixture/apps/api/AGENTS.md"
  printf '%s\n' 'Initial instructions' > "$fixture/.agents/skills/example/SKILL.md"
  printf '%s\n' '.agents/reports/' > "$fixture/.gitignore"
  git -C "$fixture" add .
  git -C "$fixture" commit -qm initial
  git -C "$fixture" branch baseline
  printf '%s\n' "$fixture"
}

expect_status() {
  local expected="$1" message="$2" output actual=0
  shift 2
  output="$(bash "$@" 2>&1)" || actual=$?
  if [[ "$actual" -ne "$expected" || "$output" != *"$message"* ]]; then
    echo "Expected status $expected containing '$message'; got $actual: $output" >&2
    exit 1
  fi
}

unrelated="$(new_repo unrelated)"
printf '%s\n' 'Unrelated edit' >> "$unrelated/README.md"
mkdir -p "$unrelated/.agents/reports"
printf '%s\n' 'Ignored report' > "$unrelated/.agents/reports/audit.md"
expect_status 77 'SKIPPED' "$script" "$unrelated" baseline
expect_status 0 'SKIPPED' "$source_check" "$unrelated" baseline
expect_status 1 'cannot determine instruction changes' "$script" "$unrelated" missing-base
expect_status 1 'cannot determine instruction changes' "$source_check" "$unrelated" missing-base

for partial in skills-only script-only; do
  fixture="$(new_repo "$partial")"
  printf '%s\n' '.ai/shared/' >> "$fixture/.gitignore"
  if [[ "$partial" == skills-only ]]; then
    mkdir -p "$fixture/.ai/shared/skills"
  else
    mkdir -p "$fixture/.ai/shared/scripts"
    printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$fixture/.ai/shared/scripts/sync-ai-skills.sh"
  fi
  expect_status 77 'SKIPPED' "$script" "$fixture" baseline
  expect_status 0 'SKIPPED' "$source_check" "$fixture" baseline
  printf '%s\n' 'Changed instructions' >> "$fixture/AGENTS.md"
  expect_status 1 'instruction files changed' "$script" "$fixture" baseline
  expect_status 1 'instruction files changed' "$source_check" "$fixture" baseline
done

for state in committed staged unstaged untracked deleted renamed staged-revert; do
  fixture="$(new_repo "$state")"
  case "$state" in
    untracked)
      printf '%s\n' 'New instructions' > "$fixture/.ai/local/new.md"
      ;;
    deleted)
      rm "$fixture/.ai/local/agents.md"
      ;;
    renamed)
      git -C "$fixture" mv .ai/local/agents.md moved.md
      ;;
    *)
      printf '%s\n' 'Changed instructions' >> "$fixture/.ai/local/agents.md"
      ;;
  esac
  case "$state" in
    committed)
      git -C "$fixture" add .ai/local/agents.md
      git -C "$fixture" commit -qm instructions
      ;;
    staged|staged-revert)
      git -C "$fixture" add .ai/local/agents.md
      ;;
  esac
  if [[ "$state" == staged-revert ]]; then
    git -C "$fixture" show HEAD:.ai/local/agents.md > "$fixture/.ai/local/agents.md"
  fi
  expect_status 1 'git submodule update --init .ai/shared' "$script" "$fixture" baseline
  expect_status 1 'git submodule update --init .ai/shared' "$source_check" "$fixture" baseline
done

path_index=0
for instruction in AGENTS.md apps/api/AGENTS.md apps/api/CLAUDE.md \
  packages/new/GEMINI.md .agents/skills/example/SKILL.md \
  .claude/skills/example/SKILL.md .ai/manifest.json .gitmodules; do
  fixture="$(new_repo "path-$path_index")"
  path_index=$((path_index + 1))
  mkdir -p "$(dirname "$fixture/$instruction")"
  printf '%s\n' 'Changed instructions' >> "$fixture/$instruction"
  expect_status 1 'instruction files changed' "$script" "$fixture" baseline
done

# A missing submodule may still have a changed gitlink in the index.
fixture="$(new_repo submodule-pin)"
git -C "$fixture" update-index --add --cacheinfo \
  "160000,$(git -C "$unrelated" rev-parse HEAD),.ai/shared"
expect_status 1 'instruction files changed' "$script" "$fixture" baseline

# The requested base controls the comparison, even when origin/main differs.
fixture="$(new_repo custom-base)"
printf '%s\n' 'Committed instructions' >> "$fixture/AGENTS.md"
git -C "$fixture" add AGENTS.md
git -C "$fixture" commit -qm instructions
git -C "$fixture" update-ref refs/remotes/origin/main HEAD
expect_status 77 'SKIPPED' "$script" "$fixture" origin/main
expect_status 1 'instruction files changed' "$script" "$fixture" baseline

sync_dir="$fixture/.ai/shared/scripts"
mkdir -p "$sync_dir"
mkdir -p "$fixture/.ai/shared/skills"
cat > "$sync_dir/sync-ai-skills.sh" <<STUB
#!/usr/bin/env bash
if [[ "\${1:-}" != "--check" || "\${2:-}" != "$fixture" ]]; then
  exit 9
fi
echo 'sync executed'
STUB

expect_status 0 'sync executed' "$script" "$fixture" baseline
printf '%s\n' 'exit 2' >> "$sync_dir/sync-ai-skills.sh"
expect_status 2 'sync executed' "$script" "$fixture" baseline
echo "AI skill sync wrapper: all tests passed"
