export const FOLIO_SCROLL_EVENT = "folio:scroll-to-block";

export type FolioScrollEventDetail = { blockId: string };

declare global {
  // eslint-disable-next-line typescript-eslint/consistent-type-definitions -- interface declaration merging required to augment lib.dom WindowEventMap; `type` does not merge
  interface WindowEventMap {
    "folio:scroll-to-block": CustomEvent<FolioScrollEventDetail>;
  }
}
