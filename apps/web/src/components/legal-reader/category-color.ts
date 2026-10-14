// ── Color system ──────────────────────────────────────────
//
// Uses --option-* CSS variables from the design-system theme so colors
// adapt to all theme palettes (neutral, nord, flexoki).

/**
 * CSS variable name for a category's accent color.
 * Core categories get fixed assignments; non-standard ones
 * get a stable hash-based pick from the remaining palette.
 */

const OPTION_VARS = [
  "--option-blue",
  "--option-amber",
  "--option-violet",
  "--option-emerald",
  "--option-cyan",
  "--option-orange",
  "--option-indigo",
  "--option-teal",
] as const;

const CORE_CATEGORY_VAR: Record<string, string> = {
  facts: "--option-blue",
  "procedural-history": "--option-amber",
  reasoning: "--option-violet",
  holding: "--option-emerald",
};

export const hashString = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    // oxlint-disable-next-line no-bitwise, unicorn/prefer-math-trunc -- djb2 hash needs shift and `| 0` int coercion
    h = ((h << 5) - h + (s.codePointAt(i) ?? 0)) | 0;
  }
  return Math.abs(h);
};

/** Get the CSS variable name for a category's color. */
export const getCategoryVar = (category: string): string => {
  const fixed = CORE_CATEGORY_VAR[category];
  if (fixed) {
    return fixed;
  }
  const idx = hashString(category) % OPTION_VARS.length;
  // idx is in [0, length); indexing is safe.
  return OPTION_VARS[idx] ?? "";
};
