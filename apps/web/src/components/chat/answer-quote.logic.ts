import { isValidElement } from "react";
import type { ReactNode } from "react";

import { panic } from "better-result";

import {
  answerQuoteKey,
  locateQuoteInBlocks,
} from "@stll/legal-ast/answer-quote";
import type { LocatedQuote } from "@stll/legal-ast/answer-quote";
import { parseDocumentAst } from "@stll/legal-ast/document-ast";

import type { ChatMessageMetadata } from "@/components/chat/chat-ui-tools";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";

// Markdown elements that start a new line of text. Inline elements
// (emphasis, links, code) join their neighbours directly, so formatting
// inside a word keeps the word whole.
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
  "blockquote",
  "br",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "ol",
  "p",
  "pre",
  "ul",
]);

const textOfNode = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child: ReactNode) => textOfNode(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    const inner = textOfNode(node.props.children);
    return typeof node.type === "string" && BLOCK_ELEMENTS.has(node.type)
      ? ` ${inner} `
      : inner;
  }
  return "";
};

/** The displayed text of rendered Markdown children, blocks set apart by a space. */
export const quoteTextOf = (node: ReactNode): string =>
  textOfNode(node).replaceAll(/\s+/gu, " ").trim();

/** What the server found for one of the answer's quotations. */
export type AnswerQuoteCheck = NonNullable<
  ChatMessageMetadata["answerQuotes"]
>[number];

/** The answer's stored quotation checks, by quotation key. */
export const answerQuoteChecksByKey = (
  checks: ChatMessageMetadata["answerQuotes"],
): ReadonlyMap<string, AnswerQuoteCheck> | null =>
  checks === undefined
    ? null
    : new Map(checks.map((check) => [check.key, check]));

/**
 * How a quotation renders:
 * - `verified`: a decision the answer cites holds it word for word.
 * - `unverified`: the server read every decision the answer cites and none
 *   holds it, nor does any decision the page has loaded.
 * - `plain`: no claim either way (nothing to check against, a decision still
 *   loading, or an answer stored before the server checked quotations).
 */
export type AnswerQuoteState =
  | {
      type: "verified";
      decision: PublicCaseLawDecision;
      located: LocatedQuote;
    }
  | { type: "unverified" }
  | { type: "plain" };

const locateInDecisions = (
  quote: string,
  decisions: readonly PublicCaseLawDecision[],
): AnswerQuoteState | null => {
  for (const decision of decisions) {
    const blocks = parseDocumentAst(decision.documentAst)?.blocks;
    const located =
      blocks === undefined ? null : locateQuoteInBlocks(quote, blocks);
    if (located !== null) {
      return { type: "verified", decision, located };
    }
  }
  return null;
};

type AnswerQuoteStateOptions = {
  quote: string;
  /** The decisions the answer cites, as the page has loaded them. */
  decisions: readonly PublicCaseLawDecision[];
  /** The server's checks; null for an answer stored without them. */
  checks: ReadonlyMap<string, AnswerQuoteCheck> | null;
};

/**
 * The server's check decides, and the page's own match against the decisions
 * it loaded still verifies: the page also resolves decisions an answer links
 * by public URL, which the server does not read.
 */
export const answerQuoteState = ({
  quote,
  decisions,
  checks,
}: AnswerQuoteStateOptions): AnswerQuoteState => {
  if (quote.length === 0) {
    return { type: "plain" };
  }
  const check = checks?.get(answerQuoteKey(quote));
  if (check?.type === "verified") {
    const decision = decisions.find(({ id }) => id === check.decisionId);
    if (decision !== undefined) {
      return {
        type: "verified",
        decision,
        located: { anchorId: check.anchorId, paragraph: check.paragraph },
      };
    }
  }
  const located = locateInDecisions(quote, decisions);
  if (located !== null) {
    return located;
  }
  switch (check?.type) {
    case undefined:
    case "unchecked":
    case "verified":
      return { type: "plain" };
    case "unverified":
      return { type: "unverified" };
    default:
      check satisfies never;
      return panic("Unhandled answer quote check");
  }
};
