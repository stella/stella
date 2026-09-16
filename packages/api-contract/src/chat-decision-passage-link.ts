/**
 * The link an answer cites a passage of a case-law decision by.
 *
 * A decision reaches the model as anchored passages (`[p-12] …`), the same
 * anchors the reader renders each block under, so an answer can point at the
 * paragraph it rests on rather than at the decision as a whole. Unlike a
 * workspace source citation this carries no tenant identity: the corpus is
 * public, and the decision id is one the prompt already named.
 */

import { panic } from "better-result";

import { isUuid } from "@stll/uuid-codec";

import { toSafeId } from "./safe-id";
import type { SafeId } from "./safe-id";

export const CHAT_DECISION_PASSAGE_HREF_PREFIX = "#stella-decision-passage=";

/**
 * The anchors the case-law parsers actually mint.
 *
 * Every decision parser composes an anchor from a fixed ASCII prefix, `-`, and
 * a block counter (`h-3`, `p-12`, `t-4`, `point7`, `_ftn2`); none slugifies
 * heading text, so no anchor carries a space, an accent, or a reserved URI
 * character. Holding the href to that charset is what lets the model append
 * the anchor verbatim: nothing needs percent-encoding, so the spelling the
 * prompt asks for and the spelling this module emits are the same string.
 */
const DECISION_ANCHOR_ID_REGEX = /^[A-Za-z0-9_-]+$/u;

/** Both components exclude it, so it separates them unambiguously. */
const COMPONENT_SEPARATOR = ":";

export type ChatDecisionPassageTarget = {
  /** The block's anchor, as the decision's AST and the reader both name it. */
  anchorId: string;
  decisionId: SafeId<"caseLawDecision">;
};

export type ChatDecisionPassageHref =
  `${typeof CHAT_DECISION_PASSAGE_HREF_PREFIX}${string}`;

/**
 * Panics rather than emitting an href the parser would refuse: a component
 * outside the grammar is a caller defect, and a serializer that quietly
 * produced an unparseable link would strand the citation at the renderer.
 */
export const toChatDecisionPassageHref = ({
  anchorId,
  decisionId,
}: ChatDecisionPassageTarget): ChatDecisionPassageHref => {
  if (!isUuid(decisionId)) {
    return panic(`Decision passage href needs a decision uuid: ${decisionId}`);
  }
  if (!DECISION_ANCHOR_ID_REGEX.test(anchorId)) {
    return panic(`Decision passage href needs a block anchor: ${anchorId}`);
  }
  return `${CHAT_DECISION_PASSAGE_HREF_PREFIX}${decisionId}${COMPONENT_SEPARATOR}${anchorId}`;
};

/**
 * The model writes these hrefs itself, so every component is checked before a
 * chip claims to open one: a decision id that is not a uuid would otherwise
 * reach the opener as free text and resolve to an unrelated decision.
 */
export const parseChatDecisionPassageHref = (
  href: string,
): ChatDecisionPassageTarget | null => {
  if (!href.startsWith(CHAT_DECISION_PASSAGE_HREF_PREFIX)) {
    return null;
  }
  const components = href
    .slice(CHAT_DECISION_PASSAGE_HREF_PREFIX.length)
    .split(COMPONENT_SEPARATOR);
  if (components.length !== 2) {
    return null;
  }
  const [decisionId, anchorId] = components;
  if (
    decisionId === undefined ||
    anchorId === undefined ||
    !isUuid(decisionId) ||
    !DECISION_ANCHOR_ID_REGEX.test(anchorId)
  ) {
    return null;
  }
  return { anchorId, decisionId: toSafeId<"caseLawDecision">(decisionId) };
};
