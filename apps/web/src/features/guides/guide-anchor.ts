import type { GuideAnchorId } from "@/features/guides/guide-anchors";

export const GUIDE_ANCHOR_ATTRIBUTE = "data-guide-anchor";

type GuideAnchorProps = { readonly "data-guide-anchor": GuideAnchorId };

// Marks a real UI element as a guide tour target. Spread the result onto the
// element's DOM node, e.g.
// `<div {...guideAnchor(GUIDE_ANCHORS.chatComposer)} />`.
// Deliberately not a hook: it holds no state and calls none, so it stays usable
// inside a nested `render={...}` element, a branch, or a loop.
// Deleting this call for a non-pending anchor fails `guides.test.tsx`, which
// forces the matching tour step and anchor to be removed as well.
export const guideAnchor = (id: GuideAnchorId): GuideAnchorProps => ({
  "data-guide-anchor": id,
});

export const guideAnchorSelector = (id: GuideAnchorId): string =>
  `[${GUIDE_ANCHOR_ATTRIBUTE}="${id}"]`;
