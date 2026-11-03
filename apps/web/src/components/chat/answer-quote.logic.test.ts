import { createElement } from "react";

import { describe, expect, test } from "bun:test";

import { toSafeId } from "@stll/api-contract/safe-id";
import { answerQuoteKey } from "@stll/legal-ast/answer-quote";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import {
  answerQuoteChecksByKey,
  answerQuoteState,
  quoteTextOf,
} from "@/components/chat/answer-quote.logic";
import type { AnswerQuoteCheck } from "@/components/chat/answer-quote.logic";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";

import { dockedChatLegalPayloads } from "../../../e2e/helpers/docked-chat-legal-payloads";

const COURT_TEXT =
  "The court preserves the remedy where the claimant acted in good faith.";
const MISQUOTE = COURT_TEXT.replace("good faith", "bad faith");

const astWith = (text: string) =>
  ({
    version: 1,
    source: { system: "", documentId: "", webUrl: "", printUrl: "" },
    metadata: {
      caseNumber: null,
      ecli: null,
      court: null,
      decisionDate: null,
      decisionType: null,
      keywords: [],
      statutes: [],
    },
    blocks: [
      {
        id: "b1",
        anchorId: "p-7",
        type: "paragraph",
        inlines: [{ type: "text", text }],
      },
    ],
  }) satisfies DocumentAst;

const loaded = {
  ...dockedChatLegalPayloads.decision,
  documentAst: astWith(COURT_TEXT),
} satisfies PublicCaseLawDecision;
const withoutText = {
  ...dockedChatLegalPayloads.decision,
  id: toSafeId<"caseLawDecision">("019a0000-0000-7000-8000-000000000109"),
} satisfies PublicCaseLawDecision;

const checks = (...entries: AnswerQuoteCheck[]) =>
  answerQuoteChecksByKey(entries);

describe("answer quotation state", () => {
  test("renders the server's verification at the paragraph it stored", () => {
    expect(
      answerQuoteState({
        quote: `„${COURT_TEXT}“`,
        decisions: [withoutText],
        checks: checks({
          type: "verified",
          key: answerQuoteKey(COURT_TEXT),
          decisionId: withoutText.id,
          anchorId: "p-3",
          paragraph: 3,
        }),
      }),
    ).toEqual({
      type: "verified",
      decision: withoutText,
      located: { anchorId: "p-3", paragraph: 3 },
    });
  });

  test("shows a server verification only once its decision has loaded", () => {
    expect(
      answerQuoteState({
        quote: COURT_TEXT,
        decisions: [],
        checks: checks({
          type: "verified",
          key: answerQuoteKey(COURT_TEXT),
          decisionId: loaded.id,
          anchorId: "p-7",
          paragraph: null,
        }),
      }),
    ).toEqual({ type: "plain" });
  });

  test("warns on a quotation the server found in no cited decision", () => {
    expect(
      answerQuoteState({
        quote: MISQUOTE,
        decisions: [loaded],
        checks: checks({ type: "unverified", key: answerQuoteKey(MISQUOTE) }),
      }),
    ).toEqual({ type: "unverified" });
  });

  test("a decision the page loaded still verifies what the server could not", () => {
    expect(
      answerQuoteState({
        quote: COURT_TEXT,
        decisions: [loaded],
        checks: checks({ type: "unverified", key: answerQuoteKey(COURT_TEXT) }),
      }),
    ).toEqual({
      type: "verified",
      decision: loaded,
      located: { anchorId: "p-7", paragraph: null },
    });
  });

  test("claims nothing for an unchecked quotation", () => {
    expect(
      answerQuoteState({
        quote: MISQUOTE,
        decisions: [loaded],
        checks: checks({ type: "unchecked", key: answerQuoteKey(MISQUOTE) }),
      }),
    ).toEqual({ type: "plain" });
  });

  test("an answer stored without checks keeps the page's own match", () => {
    expect(
      answerQuoteState({
        quote: COURT_TEXT,
        decisions: [loaded],
        checks: null,
      }),
    ).toMatchObject({ type: "verified", decision: loaded });
    expect(
      answerQuoteState({ quote: MISQUOTE, decisions: [loaded], checks: null }),
    ).toEqual({ type: "plain" });
  });

  test("an empty quotation is plain", () => {
    expect(
      answerQuoteState({
        quote: "",
        decisions: [loaded],
        checks: checks({ type: "unverified", key: answerQuoteKey("") }),
      }),
    ).toEqual({ type: "plain" });
  });
});

describe("rendered quotation text", () => {
  test("reads rendered Markdown as displayed: inline formatting joins, blocks part", () => {
    const rendered = [
      createElement(
        "p",
        { key: "a" },
        createElement("strong", null, "The court rejected the application"),
        ".",
      ),
      createElement(
        "p",
        { key: "b" },
        "the ",
        createElement("em", null, "dovol"),
        "ání",
      ),
    ];
    expect(quoteTextOf(rendered)).toBe(
      "The court rejected the application. the dovolání",
    );
  });
});
