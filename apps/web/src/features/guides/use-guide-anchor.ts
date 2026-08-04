import type { GuideAnchorId } from "@/features/guides/guide-anchors";

export const GUIDE_ANCHOR_ATTRIBUTE = "data-guide-anchor";

type GuideAnchorProps = { readonly "data-guide-anchor": GuideAnchorId };

// Marks a real UI element as a guide tour target. Spread the result onto the
// element's DOM node, e.g.
// `<div {...useGuideAnchor(GUIDE_ANCHORS.chatComposer)} />`.
// Deleting this call for a non-pending anchor fails `guides.test.tsx`, which
// forces the matching tour step and anchor to be removed as well.
export const useGuideAnchor = (id: GuideAnchorId): GuideAnchorProps => ({
  "data-guide-anchor": id,
});

export const guideAnchorSelector = (id: GuideAnchorId): string =>
  `[${GUIDE_ANCHOR_ATTRIBUTE}="${id}"]`;
