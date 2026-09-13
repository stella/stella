import type { GuideAnchorId } from "@/features/guides/guide-anchors";

export const GUIDE_ANCHOR_ATTRIBUTE = "data-guide-anchor";

export type GuideAnchorProps = {
  readonly "data-guide-anchor"?: GuideAnchorId;
};

// Marks a real UI element as a guide tour target. Spread the result onto the
// element's DOM node, e.g.
// `<div {...guideAnchor(GUIDE_ANCHORS.chatComposer)} />`.
// Deliberately not a hook: it holds no state and calls none, so it stays usable
// inside a nested `render={...}` element, a branch, or a loop.
// Deleting this call for a non-pending anchor fails `guides.test.tsx`, which
// forces the matching tour step and anchor to be removed as well.
export const guideAnchor = (
  id: GuideAnchorId,
  enabled = true,
): GuideAnchorProps => (enabled ? { "data-guide-anchor": id } : {});

export const guideAnchorSelector = (id: GuideAnchorId): string =>
  `[${GUIDE_ANCHOR_ATTRIBUTE}="${id}"]`;

export const GUIDE_REVERSE_BLOCKED_ATTRIBUTE = "data-guide-reverse-blocked";

export type GuideReverseBlockedProps = {
  readonly "data-guide-reverse-blocked"?: "";
};

// Marks a transition's reversing control (an editor's Back) as unsafe for the
// runner to press right now: with unsaved edits the control opens a
// leave-confirm dialog instead of restoring the list, and a modal under the
// spotlight is worse than staying put. Spread next to `guideAnchor(...)`.
export const guideReverseBlocked = (
  blocked: boolean,
): GuideReverseBlockedProps =>
  blocked ? { "data-guide-reverse-blocked": "" } : {};
