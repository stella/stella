import { expect, test } from "bun:test";

import type { ReaderAnswerCitation } from "@stll/api-contract/reader-answers";
import type { Block } from "@stll/legal-ast/document-ast";

import type { DecisionCitationMetadata } from "@/components/references/decision-citation-chip.logic";
import { toSafeId } from "@/lib/safe-id";

import {
  citedDecisionRead,
  resolveReaderAnswerCitation,
} from "./reader-answer-citation.logic";
import type { CitedDecisionRead } from "./reader-answer-citation.logic";

const OPEN_DECISION = toSafeId<"caseLawDecision">(
  "00000000-0000-4000-8000-000000000002",
);
const OTHER_DECISION = toSafeId<"caseLawDecision">(
  "00000000-0000-4000-8000-000000000005",
);

const openBlocks = [
  {
    id: "intro",
    anchorId: "p-1",
    type: "paragraph",
    inlines: [],
    plainText: "Introduction",
  },
  {
    id: "twelve",
    anchorId: "p-2",
    type: "paragraph",
    number: 12,
    inlines: [],
    plainText: "The applicant was not heard.",
  },
] satisfies Block[];

const otherMetadata = {
  decisionId: OTHER_DECISION,
  court: "Synthetic Supreme Court",
  courtShortCode: "SYN",
  caseNumber: "SYN 12/2026",
  decisionDate: "2026-01-12",
  readerUrl: "/law/cze/cases/synthetic-supreme-court/synthetic-decision",
  originalUrl: null,
} satisfies DecisionCitationMetadata;

const otherBlocks = [
  {
    id: "forty-eight",
    anchorId: "p-48",
    type: "paragraph",
    number: 48,
    inlines: [],
    plainText: "A hearing is required.",
  },
  {
    id: "heading",
    anchorId: "h-1",
    type: "heading",
    level: 2,
    inlines: [],
    plainText: "Reasoning",
  },
] satisfies Block[];

const loaded = {
  type: "loaded",
  decision: otherMetadata,
  blocks: otherBlocks,
} satisfies CitedDecisionRead;

const resolve = (citation: ReaderAnswerCitation, read: CitedDecisionRead) =>
  resolveReaderAnswerCitation({
    citation,
    decisionId: OPEN_DECISION,
    blocks: openBlocks,
    formatNumber: String,
    readCitedDecision: (decisionId) => {
      expect(decisionId).toBe(OTHER_DECISION);
      return read;
    },
  });

test("a paragraph of the open decision resolves to its own text, numbered as the court numbers it", () => {
  expect(
    resolve({ decisionId: OPEN_DECISION, paragraphId: "p-2" }, loaded),
  ).toEqual({
    type: "paragraph",
    reference: {
      startAnchorId: "p-2",
      endAnchorId: "p-2",
      startIndex: 1,
      endIndex: 1,
      label: "[12]",
      paragraphs: [
        {
          anchorId: "p-2",
          number: "12",
          text: "The applicant was not heard.",
        },
      ],
    },
  });
});

test("a paragraph of the open decision never reads another decision, even with the same anchor", () => {
  const target = resolveReaderAnswerCitation({
    citation: { decisionId: OPEN_DECISION, paragraphId: "p-48" },
    decisionId: OPEN_DECISION,
    blocks: openBlocks,
    formatNumber: String,
    readCitedDecision: () => {
      throw new Error("The open decision must not be read as cited");
    },
  });
  expect(target).toEqual({ type: "unresolved" });
});

test("a paragraph of another decision resolves to that decision, opened at the paragraph", () => {
  expect(
    resolve({ decisionId: OTHER_DECISION, paragraphId: "p-48" }, loaded),
  ).toEqual({
    type: "decision",
    decision: {
      ...otherMetadata,
      readerUrl: `${otherMetadata.readerUrl}#p-48`,
    },
    paragraphNumber: 48,
  });
});

test("another decision's unnumbered or missing block cites the decision without a paragraph number", () => {
  for (const paragraphId of ["h-1", "p-404"]) {
    const target = resolve({ decisionId: OTHER_DECISION, paragraphId }, loaded);
    expect(target.type).toBe("decision");
    expect(target).toMatchObject({ paragraphNumber: null });
  }
});

test("the anchor in another decision's reader link is encoded", () => {
  expect(
    resolve({ decisionId: OTHER_DECISION, paragraphId: "p 1#a" }, loaded),
  ).toMatchObject({
    decision: { readerUrl: `${otherMetadata.readerUrl}#p%201%23a` },
  });
});

test("another decision still being read is pending, and a failed read resolves to nothing", () => {
  const citation = { decisionId: OTHER_DECISION, paragraphId: "p-48" };
  expect(resolve(citation, { type: "pending" })).toEqual({ type: "pending" });
  expect(resolve(citation, { type: "unavailable" })).toEqual({
    type: "unresolved",
  });
});

test("only a decision that was read yields a citable read", () => {
  expect(citedDecisionRead({ type: "pending" })).toEqual({ type: "pending" });
  expect(citedDecisionRead({ type: "empty" })).toEqual({
    type: "unavailable",
  });
  expect(
    citedDecisionRead({
      type: "error",
      error: new Error("fixture"),
      retry: async () => {
        throw new Error("not retried");
      },
    }),
  ).toEqual({ type: "unavailable" });
});
