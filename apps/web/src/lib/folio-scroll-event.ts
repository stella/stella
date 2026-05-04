export const FOLIO_SCROLL_EVENT = "folio:scroll-to-block";

export type FolioScrollEventDetail = { blockId: string };

declare global {
  // Global augmentation requires an interface; `type` does not merge
  // with the lib.dom WindowEventMap declaration.
  // eslint-disable-next-line typescript-eslint/consistent-type-definitions
  interface WindowEventMap {
    "folio:scroll-to-block": CustomEvent<FolioScrollEventDetail>;
  }
}
