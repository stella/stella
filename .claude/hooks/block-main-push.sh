#!/bin/bash
# Block direct pushes to main/master from Claude Code.
# Exit 2 = block the tool call. Exit 0 = allow.

payload=$(cat)
command=$(echo "$payload" | jq -r '.tool_input.command // empty')

# Detect the default branch
default_branch=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||')
: "${default_branch:=main}"

current_branch=$(git branch --show-current 2>/dev/null)

# Block if current branch IS the default branch and command contains git push
# Unanchored to catch compound commands (e.g. "cd /repo && git push")
# [[:space:]]+ handles multiple spaces between git and push
if [[ "$command" =~ git[[:space:]]+push ]] && [[ "$current_branch" == "$default_branch" || "$current_branch" == "master" ]]; then
  cat >&2 << EOF
BLOCKED: Direct push to $current_branch is not allowed.

Create a feature branch and open a PR instead:
  git checkout -b feat/your-feature
  git push -u origin HEAD
  gh pr create --fill --draft
EOF
  exit 2
fi

# Also block explicit "git push origin main" from any branch
# Catches: "git push origin main", "git push origin HEAD:main", "git push origin :main"
if [[ "$command" =~ git[[:space:]]+push.*([[:space:]]|:)(main|master)([[:space:]]|:|$) ]]; then
  cat >&2 << 'EOF'
BLOCKED: Explicit push to main/master is not allowed. Use a PR.
EOF
  exit 2
fi

exit 0
