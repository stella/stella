#!/usr/bin/env bash
# Detect physical directional Tailwind CSS properties that should
# use logical equivalents for RTL support.
#
# Physical properties (ml-, mr-, pl-, pr-, left-*, right-*,
# text-left, text-right, border-l, border-r, rounded-l, rounded-r)
# are fixed to LTR layout. Logical properties (ms-, me-, ps-, pe-,
# start-*, end-*, text-start, text-end, border-s, border-e,
# rounded-s, rounded-e) adapt automatically based on dir="rtl".
#
# Usage:
#   scripts/lint-logical-properties.sh
#
# Intentional physical properties (NOT caught by this script):
#   - left-[50%] + translate-x-[-50%] centering: symmetric,
#     must stay physical since translate-x is always physical.
#   - left-0 with translate-x-(--custom-prop): the custom
#     property is a physical offset (e.g., tab indicators).
#   - right-0 with inline style={{ right: ... }}: inline
#     styles use physical properties; the class must match.
#
# Add intentional exceptions to EXCLUDE_PATTERNS below.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PATHS=(
  "$ROOT/apps/web/src"
  "$ROOT/packages/ui/src"
)

# Files where physical properties are intentional
# (centering with translate-x, tab indicators, inline
# style coordination).
EXCLUDE_PATTERNS=(
  "conversation.tsx"      # left-[50%] centering with translate-x
  "toast.tsx"             # left-1/2 centering with -translate-x-1/2
  "tabs.tsx"              # left-0 with translate-x-(--active-tab-left)
  "_protected.tsx"        # right-0/left-px with inline style
  "kanban-column.tsx"     # drag edge indicators with translate-x
  "workspace-table.tsx"   # column resize handle
  "tree-view.tsx"         # "right-click" in comments
  "sidebar.tsx"           # SidebarRail physical positioning with translate-x
  "template-preview.tsx"  # DOCX alignment is physical (text-right)
  "page-citation.tsx"     # PDF coordinates are physical (left positioning)
)

build_exclude_args() {
  local args=""
  for pat in "${EXCLUDE_PATTERNS[@]}"; do
    args+=" --glob=!**/${pat}"
  done
  echo "$args"
}

EXCLUDE_ARGS=$(build_exclude_args)

# Patterns to detect physical directional properties.
PATTERNS=(
  # Margin left/right
  '(^|[\s"'\''`{(])(-?)([\w\[\]:]*:)?(ml|mr)-'
  # Padding left/right
  '(^|[\s"'\''`{(])([\w\[\]:]*:)?(pl|pr)-'
  # Text alignment
  '(^|[\s"'\''`{(])([\w\[\]:]*:)?text-(left|right)(["\s'\''`})]|$)'
  # Border left/right
  '(^|[\s"'\''`{(])([\w\[\]:]*:)?border-(l|r)([- "'\''`})]|$)'
  # Rounded left/right and corners
  '(^|[\s"'\''`{(])([\w\[\]:]*:)?rounded-(l|r|tl|tr|bl|br)([- "'\''`})]|$)'
  # Position left/right
  '(^|[\s"'\''`{(])(-?)([\w\[\]:]*:)?(left|right)-'
  # Scroll margin/padding left/right
  '(^|[\s"'\''`{(])([\w\[\]:]*:)?scroll-(ml|mr|pl|pr)-'
)

violations=0

for search_path in "${PATHS[@]}"; do
  for pattern in "${PATTERNS[@]}"; do
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
  echo "ERROR: Found physical directional CSS properties."
  echo ""
  echo "Use logical properties instead:"
  echo "  ml-*          -> ms-*    (margin-inline-start)"
  echo "  mr-*          -> me-*    (margin-inline-end)"
  echo "  pl-*          -> ps-*    (padding-inline-start)"
  echo "  pr-*          -> pe-*    (padding-inline-end)"
  echo "  left-*        -> start-* (inset-inline-start)"
  echo "  right-*       -> end-*   (inset-inline-end)"
  echo "  text-left     -> text-start"
  echo "  text-right    -> text-end"
  echo "  border-l      -> border-s"
  echo "  border-r      -> border-e"
  echo "  rounded-l-*   -> rounded-s-*"
  echo "  rounded-r-*   -> rounded-e-*"
  echo "  rounded-tl-*  -> rounded-ss-*"
  echo "  rounded-tr-*  -> rounded-se-*"
  echo "  rounded-bl-*  -> rounded-es-*"
  echo "  rounded-br-*  -> rounded-ee-*"
  echo ""
  echo "If a physical property is intentional (e.g., a visual"
  echo "element that must always be on the physical left/right),"
  echo "add the filename to EXCLUDE_PATTERNS in this script."
  exit 1
fi

echo "No physical directional CSS property violations found."
