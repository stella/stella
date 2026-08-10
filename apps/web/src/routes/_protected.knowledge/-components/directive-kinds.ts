import {
  BLOCK_DIRECTIVE_KINDS,
  type BlockDirectiveKind,
} from "@stll/template-conditions";

// Block directives that wrap content (own paragraph). Derived from the shared
// grammar so it cannot drift from the fill pipeline's directive kinds.
export type { BlockDirectiveKind };

export type BlockDirectiveFamily = "conditional" | "iteration";

type BlockDirectiveLayout =
  | { type: "opener"; family: BlockDirectiveFamily }
  | { type: "branch"; family: "conditional" }
  | { type: "closer"; family: BlockDirectiveFamily };

export const BLOCK_DIRECTIVE_LAYOUT = {
  if: { type: "opener", family: "conditional" },
  elseif: { type: "branch", family: "conditional" },
  else: { type: "branch", family: "conditional" },
  endif: { type: "closer", family: "conditional" },
  each: { type: "opener", family: "iteration" },
  endeach: { type: "closer", family: "iteration" },
} as const satisfies Record<BlockDirectiveKind, BlockDirectiveLayout>;

export const CONDITIONAL_KINDS = BLOCK_DIRECTIVE_KINDS.filter(
  (kind) => BLOCK_DIRECTIVE_LAYOUT[kind].family === "conditional",
);
