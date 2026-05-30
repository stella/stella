/**
 * Floating text-box predicates. Ported from eigenpal docx-editor #474.
 */

import { isFloatingWrapType, isWrapNone } from "../docx/wrapTypes";
import type { TextBoxBlock } from "./types";

export type TextBoxFlowAttrs = Pick<TextBoxBlock, "displayMode" | "wrapType">;

/**
 * `true` when the text box is anchored outside normal block flow — either
 * via the `float` display mode or via an OOXML floating wrap type.
 */
export function isFloatingTextBoxBlock(block: TextBoxFlowAttrs): boolean {
  return block.displayMode === "float" || isFloatingWrapType(block.wrapType);
}

/**
 * `true` when a floating text box should also reduce surrounding text
 * line widths. Excludes wrapNone (`behind`/`inFront`) and `topAndBottom`
 * which are positioned floats but do not carve a horizontal exclusion.
 */
export function floatingTextBoxWrapsText(block: TextBoxFlowAttrs): boolean {
  return (
    isFloatingTextBoxBlock(block) &&
    !isWrapNone(block.wrapType) &&
    block.wrapType !== "topAndBottom"
  );
}
