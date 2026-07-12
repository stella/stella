import type { BLOCK_DIRECTIVE_KINDS } from "@stll/template-conditions";

// Block directives that wrap content (own paragraph). Derived from the shared
// grammar so it cannot drift from the fill pipeline's directive kinds.
export type BlockDirectiveKind = (typeof BLOCK_DIRECTIVE_KINDS)[number];

export const CONDITIONAL_KINDS: readonly BlockDirectiveKind[] = [
  "if",
  "elseif",
  "else",
  "endif",
];
