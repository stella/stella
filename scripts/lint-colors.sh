#!/usr/bin/env bash
# Detect hardcoded Tailwind color classes that break dark mode.
#
# Semantic tokens (bg-background, bg-muted, text-foreground, …) adapt
# automatically via CSS variables. Raw palette colors (bg-stone-50,
# text-gray-900, bg-white, …) are fixed and will produce unreadable
# contrast in the opposite theme.
#
# Usage:
#   scripts/lint-colors.sh
#
# Add intentional exceptions to EXCLUDE_PATTERNS below.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Gray-scale palette names that should never appear as raw utilities.
GRAY_SCALES="stone|slate|gray|zinc|neutral"

# Patterns to match (in Tailwind class-name context).
# 1) bg-/text-/border- with raw gray-scale palettes
# 2) standalone bg-white or bg-black (not bg-white/20 etc.)
GRAY_PATTERN="(bg|text|border|ring|outline|shadow)-(${GRAY_SCALES})-[0-9]"
WHITE_PATTERN="bg-white[^/]|bg-white$|bg-black[^/]|bg-black$"

PATHS=(
  "$ROOT/apps/web/src"
)

# Files to exclude (intentional hardcoded colors).
EXCLUDE_PATTERNS=(
  "appearance-settings.tsx"  # palette swatch previews
)

build_exclude_args() {
  local args=()
  for pat in "${EXCLUDE_PATTERNS[@]}"; do
    args+=("--glob=!**/${pat}")
  done
  echo "${args[*]}"
}

EXCLUDE_ARGS=$(build_exclude_args)

violations=0

for search_path in "${PATHS[@]}"; do
  for pattern in "$GRAY_PATTERN" "$WHITE_PATTERN"; do
    # shellcheck disable=SC2086
    results=$(rg \
      --type-add 'tsx:*.tsx' --type-add 'tsx:*.ts' \
      --type tsx \
      --no-heading --line-number --column \
      $EXCLUDE_ARGS \
      "$pattern" \
      "$search_path" 2>/dev/null || true)

    if [[ -n "$results" ]]; then
      violations=1
      echo "$results"
    fi
  done
done

if [[ $violations -eq 1 ]]; then
  echo ""
  echo "ERROR: Found hardcoded Tailwind color classes."
  echo ""
  echo "Use semantic tokens instead:"
  echo "  bg-stone-50   -> bg-muted or bg-card"
  echo "  bg-sky-50     -> bg-info/10 or bg-accent"
  echo "  bg-white      -> bg-background"
  echo "  text-gray-*   -> text-foreground or text-muted-foreground"
  echo "  hover:bg-*-50 -> hover:bg-accent"
  echo ""
  echo "If the color is intentional (e.g. a swatch preview),"
  echo "add the filename to EXCLUDE_PATTERNS in this script."
  exit 1
fi

echo "No hardcoded color violations found."
