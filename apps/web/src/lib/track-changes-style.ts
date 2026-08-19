import type { CSSProperties } from "react";

// Track-changes styling, matched to folio's suggestion preview
// (.folio-ai-suggestion--focused-original/-replacement): deletions read as
// dimmed muted strikethrough with a faint destructive tint, insertions as a
// low-saturation success wash with an inset ring. color-mix over semantic
// tokens keeps both theme-aware without importing folio's stylesheet.
//
// One definition for the whole product: every surface that shows a text
// difference (document versions, statute provisions) has to read as the same
// visual language, and a second copy would drift from this one silently.

export const TRACKED_DELETION_STYLE: CSSProperties = {
  color: "color-mix(in oklch, var(--destructive) 35%, var(--muted-foreground))",
  textDecorationLine: "line-through",
  textDecorationThickness: "1px",
  textDecorationColor:
    "color-mix(in oklch, var(--destructive) 30%, var(--muted-foreground))",
};

export const TRACKED_INSERTION_STYLE: CSSProperties = {
  borderRadius: "3px",
  padding: "0 2px",
  backgroundColor: "color-mix(in oklch, var(--success) 14%, transparent)",
  boxShadow:
    "inset 0 0 0 1px color-mix(in oklch, var(--success) 28%, transparent)",
  textDecorationLine: "none",
  boxDecorationBreak: "clone",
  WebkitBoxDecorationBreak: "clone",
};
