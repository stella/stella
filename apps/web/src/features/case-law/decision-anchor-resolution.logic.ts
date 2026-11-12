/**
 * Anchors a reader holds (a URL fragment, a stored chat or answer link, a
 * reader answer's paragraph) against the decision document it shows now.
 *
 * An anchor the document has is current and costs no read. Any other anchor
 * is asked of the decision's redirects, and `resolveDecisionAnchor` from the
 * API contract combines the answer with the shown document, so a link never
 * lands on other text. Every reader-side consumer goes through here.
 */

import { panic } from "better-result";

import {
  DECISION_ANCHOR_REDIRECT_MAX_ANCHORS,
  DECISION_ANCHOR_RESOLUTION,
  type DecisionAnchorRedirect,
  type DecisionAnchorResolution,
  resolveDecisionAnchor,
} from "@stll/api-contract/case-law-anchor-redirects";

export const HELD_ANCHOR_STATE = {
  /** The redirect read for this anchor has not answered yet. */
  PENDING: "pending",
  /** The redirect read failed; the anchor's target is unknown. */
  UNAVAILABLE: "unavailable",
} as const;

export type HeldDecisionAnchor =
  | DecisionAnchorResolution
  | { type: typeof HELD_ANCHOR_STATE.PENDING }
  | { type: typeof HELD_ANCHOR_STATE.UNAVAILABLE };

/**
 * The anchors that need a redirect read, de-duplicated and split into
 * batches one read accepts. Anchors the shown document holds need none.
 */
export const anchorRedirectBatches = (
  anchors: readonly string[],
  currentAnchors: ReadonlySet<string>,
): string[][] => {
  const unknown = [
    ...new Set(anchors.filter((anchor) => !currentAnchors.has(anchor))),
  ];
  const batches: string[][] = [];
  for (
    let start = 0;
    start < unknown.length;
    start += DECISION_ANCHOR_REDIRECT_MAX_ANCHORS
  ) {
    batches.push(
      unknown.slice(start, start + DECISION_ANCHOR_REDIRECT_MAX_ANCHORS),
    );
  }
  return batches;
};

/** One batch's read, as the hook observes it. */
export type AnchorRedirectRead =
  | { type: "pending"; anchors: readonly string[] }
  | { type: "failed"; anchors: readonly string[] }
  | {
      type: "answered";
      items: readonly { anchor: string; redirect: DecisionAnchorRedirect }[];
    };

type ResolveHeldDecisionAnchorOptions = {
  anchor: string;
  currentAnchors: ReadonlySet<string>;
  reads: readonly AnchorRedirectRead[];
};

/** Where one held anchor points in the shown document, or why it is unknown. */
export const resolveHeldDecisionAnchor = ({
  anchor,
  currentAnchors,
  reads,
}: ResolveHeldDecisionAnchorOptions): HeldDecisionAnchor => {
  if (currentAnchors.has(anchor)) {
    return { type: DECISION_ANCHOR_RESOLUTION.CURRENT, anchorId: anchor };
  }
  for (const read of reads) {
    switch (read.type) {
      case "answered": {
        const item = read.items.find(
          (candidate) => candidate.anchor === anchor,
        );
        if (item !== undefined) {
          return resolveDecisionAnchor({
            anchor,
            currentAnchors,
            redirect: item.redirect,
          });
        }
        break;
      }
      case "pending":
        if (read.anchors.includes(anchor)) {
          return { type: HELD_ANCHOR_STATE.PENDING };
        }
        break;
      case "failed":
        if (read.anchors.includes(anchor)) {
          return { type: HELD_ANCHOR_STATE.UNAVAILABLE };
        }
        break;
      default:
        read satisfies never;
        return panic("Unhandled anchor redirect read");
    }
  }
  // Every unknown anchor is in a batch, so a miss is a batch not yet issued.
  return { type: HELD_ANCHOR_STATE.PENDING };
};

/** The anchor a held anchor should be shown at, when it has one. */
export const heldAnchorTarget = (held: HeldDecisionAnchor) => {
  switch (held.type) {
    case DECISION_ANCHOR_RESOLUTION.CURRENT:
    case DECISION_ANCHOR_RESOLUTION.MOVED:
      return held.anchorId;
    case DECISION_ANCHOR_RESOLUTION.GONE:
    case HELD_ANCHOR_STATE.PENDING:
    case HELD_ANCHOR_STATE.UNAVAILABLE:
      return undefined;
    default:
      held satisfies never;
      return panic("Unhandled held decision anchor");
  }
};
