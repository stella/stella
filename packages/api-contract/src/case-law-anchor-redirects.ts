/**
 * Where a decision block anchor a caller holds points now.
 *
 * A reparse can drop an anchor (its block's words changed, it was split or
 * joined, or the decision moved from positional to stable anchors). The
 * decision keeps a redirect for every anchor an earlier version of its
 * document held: the anchor now holding the same text, or none. The public
 * redirect read answers from those redirects alone; a caller combines the
 * answer with the anchors of the document it already holds
 * (`resolveDecisionAnchor`), so an anchor never lands on other text.
 */

import { panic } from "better-result";
import * as v from "valibot";

/** What the stored redirects say about one anchor. */
export const DECISION_ANCHOR_REDIRECT = {
  /** An earlier document held it; it now lives under `anchorId`. */
  MOVED: "moved",
  /** An earlier document held it; no block holds its text now. */
  GONE: "gone",
  /** No redirect: the anchor is current, or no version ever held it. */
  NOT_REDIRECTED: "not-redirected",
} as const;

export type DecisionAnchorRedirect =
  | { type: typeof DECISION_ANCHOR_REDIRECT.MOVED; anchorId: string }
  | { type: typeof DECISION_ANCHOR_REDIRECT.GONE }
  | { type: typeof DECISION_ANCHOR_REDIRECT.NOT_REDIRECTED };

/** The most anchors one redirect read answers. */
export const DECISION_ANCHOR_REDIRECT_MAX_ANCHORS = 50;
/** The longest anchor a redirect read accepts. */
export const DECISION_ANCHOR_MAX_LENGTH = 200;

const anchorSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(DECISION_ANCHOR_MAX_LENGTH),
);

export const decisionAnchorRedirectsResponseSchema = v.object({
  items: v.array(
    v.object({
      anchor: anchorSchema,
      redirect: v.variant("type", [
        v.object({
          type: v.literal(DECISION_ANCHOR_REDIRECT.MOVED),
          anchorId: anchorSchema,
        }),
        v.object({ type: v.literal(DECISION_ANCHOR_REDIRECT.GONE) }),
        v.object({ type: v.literal(DECISION_ANCHOR_REDIRECT.NOT_REDIRECTED) }),
      ]),
    }),
  ),
});

export type DecisionAnchorRedirectsResponse = v.InferOutput<
  typeof decisionAnchorRedirectsResponseSchema
>;

export const DECISION_ANCHOR_RESOLUTION = {
  /** The held document has the anchor. */
  CURRENT: "current",
  /** The anchor's text lives under another anchor of the held document. */
  MOVED: "moved",
  /** No block of the held document holds the anchor's text. */
  GONE: "gone",
} as const;

/** Where an anchor a caller holds points in the document it holds now. */
export type DecisionAnchorResolution =
  | { type: typeof DECISION_ANCHOR_RESOLUTION.CURRENT; anchorId: string }
  | { type: typeof DECISION_ANCHOR_RESOLUTION.MOVED; anchorId: string }
  | { type: typeof DECISION_ANCHOR_RESOLUTION.GONE };

type ResolveDecisionAnchorOptions = {
  anchor: string;
  /** Every anchor of the document the caller holds. */
  currentAnchors: ReadonlySet<string>;
  /** The stored redirect for `anchor`. */
  redirect: DecisionAnchorRedirect;
};

/**
 * The one place an anchor is resolved. A held anchor is current; otherwise
 * its redirect decides, and a redirect target the held document does not
 * have (a document read before the write that moved it) is gone rather than
 * guessed.
 */
export const resolveDecisionAnchor = ({
  anchor,
  currentAnchors,
  redirect,
}: ResolveDecisionAnchorOptions): DecisionAnchorResolution => {
  if (currentAnchors.has(anchor)) {
    return { type: DECISION_ANCHOR_RESOLUTION.CURRENT, anchorId: anchor };
  }
  switch (redirect.type) {
    case DECISION_ANCHOR_REDIRECT.MOVED:
      return currentAnchors.has(redirect.anchorId)
        ? {
            type: DECISION_ANCHOR_RESOLUTION.MOVED,
            anchorId: redirect.anchorId,
          }
        : { type: DECISION_ANCHOR_RESOLUTION.GONE };
    case DECISION_ANCHOR_REDIRECT.GONE:
    case DECISION_ANCHOR_REDIRECT.NOT_REDIRECTED:
      return { type: DECISION_ANCHOR_RESOLUTION.GONE };
    default:
      redirect satisfies never;
      return panic("Unhandled decision anchor redirect");
  }
};
