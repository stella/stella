/**
 * The link an answer cites a passage of a case-law decision by.
 *
 * A decision reaches the model as anchored passages (`[p-12] …`), the same
 * anchors the reader renders each block under, so an answer can point at the
 * paragraph it rests on rather than at the decision as a whole. Unlike a
 * workspace source citation this carries no tenant identity: the corpus is
 * public, and the decision id is one the prompt already named.
 *
 * The model writes `<decision>:<anchor>`. The server then stamps the number
 * the court printed on that block, when it printed one, as a third component
 * (`<decision>:<anchor>:<number>`) before the answer is streamed or stored, so
 * every reader of the persisted text (the chip, a reload, an export) names the
 * paragraph without reading the decision again.
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

/**
 * The court's own paragraph number, as the server stamps it: a positive whole
 * number with no leading zero, so one number has one spelling.
 */
const COURT_PARAGRAPH_NUMBER_REGEX = /^[1-9][0-9]*$/u;

/** Every component excludes it, so it separates them unambiguously. */
const COMPONENT_SEPARATOR = ":";

/** A candidate href inside Markdown: it runs to the link's `)` or a space. */
const HREF_IN_TEXT_REGEX = /#stella-decision-passage=[^\s)]*/gu;

export type ChatDecisionPassage = {
  /** The block's anchor, as the decision's AST and the reader both name it. */
  anchorId: string;
  decisionId: SafeId<"caseLawDecision">;
};

export type ChatDecisionPassageTarget = ChatDecisionPassage & {
  /**
   * The paragraph number the court printed on the cited block, or null when
   * it printed none. Only the server stamps it, from the decision's AST; the
   * anchor is a block counter and never stands in for it.
   */
  courtParagraphNumber: number | null;
};

export type ChatDecisionPassageHref =
  `${typeof CHAT_DECISION_PASSAGE_HREF_PREFIX}${string}`;

const isCourtParagraphNumber = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1;

/**
 * Panics rather than emitting an href the parser would refuse: a component
 * outside the grammar is a caller defect, and a serializer that quietly
 * produced an unparseable link would strand the citation at the renderer.
 */
export const toChatDecisionPassageHref = ({
  anchorId,
  courtParagraphNumber,
  decisionId,
}: ChatDecisionPassageTarget): ChatDecisionPassageHref => {
  if (!isUuid(decisionId)) {
    return panic(`Decision passage href needs a decision uuid: ${decisionId}`);
  }
  if (!DECISION_ANCHOR_ID_REGEX.test(anchorId)) {
    return panic(`Decision passage href needs a block anchor: ${anchorId}`);
  }
  if (
    courtParagraphNumber !== null &&
    !isCourtParagraphNumber(courtParagraphNumber)
  ) {
    return panic(
      `Decision passage href needs a court paragraph number: ${courtParagraphNumber}`,
    );
  }
  const passage: ChatDecisionPassageHref = `${CHAT_DECISION_PASSAGE_HREF_PREFIX}${decisionId}${COMPONENT_SEPARATOR}${anchorId}`;
  return courtParagraphNumber === null
    ? passage
    : `${passage}${COMPONENT_SEPARATOR}${courtParagraphNumber}`;
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
  if (components.length !== 2 && components.length !== 3) {
    return null;
  }
  const [decisionId, anchorId, number] = components;
  if (
    decisionId === undefined ||
    anchorId === undefined ||
    !isUuid(decisionId) ||
    !DECISION_ANCHOR_ID_REGEX.test(anchorId) ||
    (number !== undefined && !COURT_PARAGRAPH_NUMBER_REGEX.test(number))
  ) {
    return null;
  }
  const courtParagraphNumber = number === undefined ? null : Number(number);
  if (
    courtParagraphNumber !== null &&
    !isCourtParagraphNumber(courtParagraphNumber)
  ) {
    return null;
  }
  return {
    anchorId,
    courtParagraphNumber,
    decisionId: toSafeId<"caseLawDecision">(decisionId),
  };
};

/** Every well-formed passage citation in a text, in the order written. */
export const chatDecisionPassagesIn = (
  text: string,
): ChatDecisionPassageTarget[] =>
  text.includes(CHAT_DECISION_PASSAGE_HREF_PREFIX)
    ? Array.from(text.matchAll(HREF_IN_TEXT_REGEX), ([candidate]) =>
        parseChatDecisionPassageHref(candidate),
      ).filter((target) => target !== null)
    : [];

/**
 * Every passage citation in a text, restamped with the number the server
 * resolves for its block.
 *
 * Whatever number an href already carries is discarded first: the model can
 * copy one from an earlier answer, and only the decision's AST may say which
 * paragraph the court numbered. A candidate that does not parse is left as
 * written, so the renderer degrades it exactly as it would have.
 */
export const stampChatDecisionPassageHrefs = (
  text: string,
  courtParagraphNumberOf: (passage: ChatDecisionPassage) => number | null,
): string =>
  text.includes(CHAT_DECISION_PASSAGE_HREF_PREFIX)
    ? text.replaceAll(HREF_IN_TEXT_REGEX, (candidate) => {
        const target = parseChatDecisionPassageHref(candidate);
        if (target === null) {
          return candidate;
        }
        const number = courtParagraphNumberOf({
          anchorId: target.anchorId,
          decisionId: target.decisionId,
        });
        return toChatDecisionPassageHref({
          anchorId: target.anchorId,
          decisionId: target.decisionId,
          courtParagraphNumber:
            number !== null && isCourtParagraphNumber(number) ? number : null,
        });
      })
    : text;
