import { Result } from "better-result";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import {
  parseChatDecisionPassageHref,
  parseChatResourceHref,
  RESOURCE_TYPE,
} from "@stll/api-contract";
import type { SafeId } from "@stll/api-contract/safe-id";
import { withTimeout } from "@stll/concurrency/with-timeout";
import {
  answerQuoteKey,
  locateQuoteInBlocks,
} from "@stll/legal-ast/answer-quote";

import { isChatTextPart } from "@/api/handlers/chat/chat-message-parts";
import type {
  ChatAnswerQuoteCheck,
  ChatMessage,
} from "@/api/handlers/chat/types";
import {
  COURT_PARAGRAPH_NUMBER_DECISIONS_MAX,
  loadDecisionBlocks,
} from "@/api/lib/case-law/court-paragraph-numbers";
import type { DecisionBlocksByDecision } from "@/api/lib/case-law/court-paragraph-numbers";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  identifier?: string;
  url?: string;
  value?: string;
};

// The nodes whose rendered element the answer renderer reads as a block
// (`quoteTextOf` in the web app), so their text is set apart from its
// neighbours exactly as the browser reads a rendered quotation.
const BLOCK_NODE_TYPES: ReadonlySet<string> = new Set([
  "blockquote",
  "code",
  "heading",
  "list",
  "listItem",
  "paragraph",
]);

const TEXT_NODE_TYPES: ReadonlySet<string> = new Set([
  "code",
  "inlineCode",
  "text",
]);

const displayedTextOf = (node: MarkdownNode): string => {
  if (TEXT_NODE_TYPES.has(node.type)) {
    return node.value ?? "";
  }
  if (node.type === "break") {
    return " ";
  }
  const inner = (node.children ?? []).map(displayedTextOf).join("");
  return BLOCK_NODE_TYPES.has(node.type) ? ` ${inner} ` : inner;
};

type AnswerMarkdown = {
  /** Every blockquote's displayed text, nested ones included. */
  quotes: string[];
  /** Decisions linked by id, in the order written. */
  decisionIds: SafeId<"caseLawDecision">[];
};

/** Uses the renderer's CommonMark/GFM grammar, so only rendered blockquotes and links count. */
const readAnswerMarkdown = (markdown: string): AnswerMarkdown => {
  const tree: MarkdownNode = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const definitions = new Map<string, string>();
  const hrefs: string[] = [];
  const references: string[] = [];
  const quotes: string[] = [];
  const nodes = [tree];
  for (let node = nodes.pop(); node !== undefined; node = nodes.pop()) {
    switch (node.type) {
      case "blockquote":
        quotes.push(displayedTextOf(node).replaceAll(/\s+/gu, " ").trim());
        break;
      case "definition":
        if (
          node.identifier !== undefined &&
          node.url !== undefined &&
          !definitions.has(node.identifier)
        ) {
          definitions.set(node.identifier, node.url);
        }
        break;
      case "link":
        if (node.url !== undefined) {
          hrefs.push(node.url);
        }
        break;
      case "linkReference":
        if (node.identifier !== undefined) {
          references.push(node.identifier);
        }
        break;
      default:
        break;
    }
    nodes.push(...(node.children ?? []).toReversed());
  }
  for (const identifier of references) {
    const href = definitions.get(identifier);
    if (href !== undefined) {
      hrefs.push(href);
    }
  }
  const decisionIds: SafeId<"caseLawDecision">[] = [];
  for (const href of hrefs) {
    const passage = parseChatDecisionPassageHref(href);
    if (passage !== null) {
      decisionIds.push(passage.decisionId);
      continue;
    }
    const target = parseChatResourceHref(href);
    if (target?.type === RESOURCE_TYPE.CASE_LAW_DECISION) {
      decisionIds.push(target.resource.id);
    }
  }
  return { quotes, decisionIds };
};

/**
 * The longest the finished answer waits for the cited decisions. Past it the
 * answer carries no checks and the renderer checks its quotations itself, as
 * it does for answers stored before the server checked them.
 */
const ANSWER_QUOTE_LOOKUP_TIMEOUT_MS = 1500;

const ANSWER_QUOTE_LOOKUP_FAILED_SINK = failureSink({
  event: "chat.answer_quote_lookup_failed",
  expected: [],
});

type CheckAnswerQuotesOptions = {
  message: Pick<ChatMessage, "parts">;
  load: (
    decisionIds: readonly SafeId<"caseLawDecision">[],
  ) => Promise<DecisionBlocksByDecision>;
  timeoutMs?: number | undefined;
};

/**
 * What checking an answer's quotations established. `unavailable`: the cited
 * decisions could not be read in time, so nothing is stored and the renderer
 * checks; a check that did not run is never stored as a result.
 */
export type AnswerQuoteCheckOutcome =
  | { type: "checked"; checks: ChatAnswerQuoteCheck[] }
  | { type: "no-quotations" }
  | { type: "unavailable" };

/** Checks every quotation of an answer against the decisions it cites by id. */
export const checkAnswerQuotes = async ({
  message,
  load,
  timeoutMs = ANSWER_QUOTE_LOOKUP_TIMEOUT_MS,
}: CheckAnswerQuotesOptions): Promise<AnswerQuoteCheckOutcome> => {
  const quotes = new Map<string, string>();
  const cited = new Set<SafeId<"caseLawDecision">>();
  for (const part of message.parts) {
    if (!isChatTextPart(part)) {
      continue;
    }
    const markdown = readAnswerMarkdown(part.content);
    for (const quote of markdown.quotes) {
      const key = answerQuoteKey(quote);
      if (key.length > 0 && !quotes.has(key)) {
        quotes.set(key, quote);
      }
    }
    for (const decisionId of markdown.decisionIds) {
      cited.add(decisionId);
    }
  }
  if (quotes.size === 0) {
    return { type: "no-quotations" };
  }
  if (cited.size === 0) {
    return {
      type: "checked",
      checks: [...quotes.keys()].map((key): ChatAnswerQuoteCheck => ({
        type: "unchecked",
        key,
      })),
    };
  }
  const requested = [...cited].slice(0, COURT_PARAGRAPH_NUMBER_DECISIONS_MAX);
  const read = await Result.tryPromise(
    async () =>
      await withTimeout(async () => await load(requested), {
        label: "chat answer quote lookup",
        timeoutMs,
      }),
  );
  if (Result.isError(read)) {
    observeFailure(read.error, { sink: ANSWER_QUOTE_LOOKUP_FAILED_SINK });
    return { type: "unavailable" };
  }
  const loaded = read.value;
  // A quotation no read decision holds may still come from one that could
  // not be read (restricted, no document, past the bound): not a misquote.
  const everyCitedRead = [...cited].every((decisionId) =>
    loaded.has(decisionId),
  );
  const checks = [...quotes].map(([key, quote]): ChatAnswerQuoteCheck => {
    for (const decisionId of requested) {
      const blocks = loaded.get(decisionId);
      const located =
        blocks === undefined ? null : locateQuoteInBlocks(quote, blocks);
      if (located !== null) {
        return {
          type: "verified",
          key,
          decisionId,
          anchorId: located.anchorId,
          paragraph: located.paragraph,
        };
      }
    }
    return everyCitedRead
      ? { type: "unverified", key }
      : { type: "unchecked", key };
  });
  return { type: "checked", checks };
};

/** Checks an answer's quotations once it is complete. */
export type AnswerQuoteChecker = (
  message: Pick<ChatMessage, "parts">,
) => Promise<AnswerQuoteCheckOutcome>;

/** A chat turn's checker: cited decisions are read through the public corpus gate. */
export const createTurnAnswerQuoteChecker =
  ({
    caseLawDb,
  }: {
    caseLawDb: Parameters<typeof loadDecisionBlocks>[0]["caseLawDb"];
  }): AnswerQuoteChecker =>
  async (message) =>
    await checkAnswerQuotes({
      message,
      load: async (decisionIds) =>
        await loadDecisionBlocks({ caseLawDb, decisionIds }),
    });

/** A checker that reads no decision: quotations are checked by the renderer. */
export const NO_ANSWER_QUOTE_CHECKER: AnswerQuoteChecker = async () =>
  await Promise.resolve({ type: "unavailable" });
