export const FOLIO_SCROLL_EVENT = "folio:scroll-to-block";

/**
 * `fieldId` targets the editor mounted for that file field; listeners
 * ignore events addressed to a different field. Absent `fieldId` is a
 * broadcast for dispatchers that cannot know which surface owns the
 * block (e.g. inline chat chips) — those stay scroll-only, so a
 * positional `seq-NNNN` id resolving in the wrong document cannot
 * paint a passage highlight there.
 */
export type FolioScrollEventDetail = {
  blockId: string;
  fieldId?: string;
  text?: string;
};

declare global {
  // eslint-disable-next-line typescript-eslint/consistent-type-definitions -- interface declaration merging required to augment lib.dom WindowEventMap; `type` does not merge
  interface WindowEventMap {
    "folio:scroll-to-block": CustomEvent<FolioScrollEventDetail>;
  }
}
