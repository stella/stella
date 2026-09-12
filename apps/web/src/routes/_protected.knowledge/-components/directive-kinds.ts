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
  elif: { type: "branch", family: "conditional" },
  else: { type: "branch", family: "conditional" },
  endif: { type: "closer", family: "conditional" },
  for: { type: "opener", family: "iteration" },
  endfor: { type: "closer", family: "iteration" },
} as const satisfies Record<BlockDirectiveKind, BlockDirectiveLayout>;

export const CONDITIONAL_KINDS = BLOCK_DIRECTIVE_KINDS.filter(
  (kind) => BLOCK_DIRECTIVE_LAYOUT[kind].family === "conditional",
);

/** The two blocks a selection can be wrapped in from the gesture bar, the
 *  context menu, or the insert menu. Both are grammar opener kinds. */
export type BlockGestureKind = {
  [
    TKind in BlockDirectiveKind
  ]: (typeof BLOCK_DIRECTIVE_LAYOUT)[TKind]["type"] extends "opener"
    ? TKind
    : never;
}[BlockDirectiveKind];

/** Block directives that own the content after them — an opener and every
 *  branch that continues it. Derived from the layout map, so a new directive
 *  joins or stays out of this set by the disposition declared there. */
export type GroupDirectiveKind = {
  [
    TKind in BlockDirectiveKind
  ]: (typeof BLOCK_DIRECTIVE_LAYOUT)[TKind]["type"] extends "closer"
    ? never
    : TKind;
}[BlockDirectiveKind];
