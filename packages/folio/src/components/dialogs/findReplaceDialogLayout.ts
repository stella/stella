import type { CSSProperties } from "react";

export const FIND_REPLACE_DIALOG_TOP = "var(--folio-find-replace-top, 7rem)";
export const FIND_REPLACE_DIALOG_LEFT =
  "var(--folio-find-replace-left, 5.5rem)";

export function getFindReplaceOverlayStyle(
  style: CSSProperties | undefined,
): CSSProperties {
  return {
    top: FIND_REPLACE_DIALOG_TOP,
    left: FIND_REPLACE_DIALOG_LEFT,
    ...style,
  };
}
