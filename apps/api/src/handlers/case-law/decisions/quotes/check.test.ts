import { expect, test } from "bun:test";
import * as v from "valibot";

import { DECISION_READ_RESOLUTION } from "@stll/api-contract/case-law-decision-resolution";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { createSafeId } from "@/api/lib/branded-types";
import { readDecisionTextMetadata } from "@/api/lib/case-law/decision-text";
import { LIMITS } from "@/api/lib/limits";
import { projectResponseText } from "@/api/lib/search/project-response-text";
import type { ReadCaseLawDecisionSuccess } from "@/api/mcp/public-law-handlers";
import {
  verifyQuoteArgsSchema,
  verifyQuoteOutputSchema,
} from "@/api/mcp/verify-quote-tools";
import { quoteInputWithinBudget } from "@/api/mcp/verify-quote.logic";

import { verifyDecisionQuotation } from "./verification";

const id = createSafeId<"caseLawDecision">();
const readOf = () =>
  ({
    id,
    documentPending: false,
    documentReadFailed: false,
    documentUnavailable: false,
    hasDocument: true,
    resolution: { type: DECISION_READ_RESOLUTION.DIRECT },
    caseNumber: "1 Test 1/2026",
    caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
    court: "Nejvyšší soud",
    courtId: null,
    courtAbbreviation: "NS",
    courtTier: "supreme",
    country: "CZE",
    language: "cs",
    languageGroupKey: null,
    languageAlternates: [],
    decisionDate: null,
    decisionType: null,
    citationCount: 0,
    slug: null,
    ecli: null,
    identifiers: [
      { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: "1 Test 1/2026" },
    ],
    documentAst: null,
    projectionDigest: null,
    documentAstSource: null,
    fulltext: "Soud návrh zamítl pro opožděnost podání.",
    sections: null,
    sourceUrl: "https://example.test/decision",
    sourceAttributionUrl: "https://example.test/decision",
    documentUrl: "https://example.test/decision.pdf",
    ...readDecisionTextMetadata({}),
    headnote: readDecisionTextMetadata({}).textFields.headnote,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    source: {
      id: createSafeId<"caseLawSource">(),
      name: "Test source",
      adapterKey: "sk-courts",
      allowsDerivedAi: true,
    },
    judges: [],
    citationsFrom: [],
    citationsTo: [],
    citationsNextCursor: null,
    caseFile: { items: [], nextCursor: null, limit: 50 },
    extractionWarnings: [],
    sourceLanguages: [],
  }) satisfies ReadCaseLawDecisionSuccess;

const verify = (read: ReadCaseLawDecisionSuccess, quote: string) =>
  v.parse(
    verifyQuoteOutputSchema,
    projectResponseText(
      verifyDecisionQuotation({ read, quote, readSharedCorpus: () => false }),
      verifyQuoteOutputSchema,
    ),
  );

test("a quotation verifies exact text and exposes fuzzy alterations", () => {
  expect(verify(readOf(), "Soud návrh zamítl")).toMatchObject({
    status: "exact",
    verified: true,
    decisionId: id,
    textSource: "fulltext",
  });
  const fuzzy = verify(readOf(), "Soud návrh přijal pro opožděnost podání.");
  expect(fuzzy).toMatchObject({ status: "fuzzy", verified: false });
  if (fuzzy.status === "fuzzy") {
    expect(fuzzy.segments.at(0)?.closest?.differences).toContainEqual({
      type: "added",
      words: ["přijal"],
    });
  }
});

test("an absent quote is not_found and unreadable text is cannot_verify", () => {
  expect(
    verify(readOf(), "Zcela odlišná citace právního závěru."),
  ).toMatchObject({ status: "not_found", verified: false });
  expect(
    verify(
      { ...readOf(), documentReadFailed: true, fulltext: null },
      "Soud návrh zamítl",
    ),
  ).toMatchObject({
    status: "cannot_verify",
    verified: false,
    textState: "failed",
  });
});

test("a stored span longer than its text bound is cut, and its offsets still address all of it", () => {
  const gap = " ".repeat(40_000);
  const fulltext = `Soud${gap}návrh zamítl.`;
  const result = verify({ ...readOf(), fulltext }, "Soud návrh zamítl");
  if (result.status !== "exact") {
    throw new Error(`Expected an exact match, got ${result.status}`);
  }
  const passage = result.segments.at(0)?.occurrences.at(0);
  expect(passage?.start).toBe(0);
  expect(passage?.end).toBe(fulltext.indexOf("."));
  expect(Buffer.byteLength(passage?.text ?? "", "utf-8")).toBeLessThanOrEqual(
    16_384,
  );
});

test("a long unbroken stored word is bounded in a closest passage", () => {
  const word = "a".repeat(40_000);
  const result = verify(
    { ...readOf(), fulltext: `Soud ${word} podání.` },
    "Soud návrh podání.",
  );
  if (result.status === "exact" || result.status === "cannot_verify") {
    throw new Error(`Expected a closest passage, got ${result.status}`);
  }
  const closest = result.segments.at(0)?.closest;
  expect(closest?.differences.flatMap(({ words }) => words)).toContain(
    "a".repeat(1024),
  );
});

test("a closest passage over the whole quote budget stays within its array bounds", () => {
  const words = Array.from(
    { length: LIMITS.caseLawQuoteMaxTokens },
    (_, index) => `slovo${index}`,
  );
  const interleaved = words.flatMap((word) => [word, "vložené"]).join(" ");
  const result = verify(
    { ...readOf(), fulltext: interleaved },
    words.join(" "),
  );
  expect(result.status === "fuzzy" || result.status === "not_found").toBe(true);
});

test("the paragraphs a passage reports stop at their bound", () => {
  const paragraphs = Array.from(
    { length: LIMITS.caseLawQuoteMaxPassageParagraphs + 8 },
    (_, index) => `slovo${index}`,
  );
  const result = verify(
    { ...readOf(), fulltext: paragraphs.join("\n\n") },
    paragraphs.join(" "),
  );
  if (result.status !== "exact") {
    throw new Error(`Expected an exact match, got ${result.status}`);
  }
  expect(result.segments.at(0)?.occurrences.at(0)?.paragraphs).toHaveLength(
    LIMITS.caseLawQuoteMaxPassageParagraphs,
  );
});

test("an oversized quote is out of budget before its tokens are counted", () => {
  // One token and one segment: only the length can refuse it.
  const oversized = "a".repeat(LIMITS.caseLawQuoteMaxChars + 1);
  expect(quoteInputWithinBudget(oversized)).toBe(false);
  expect(
    v.safeParse(verifyQuoteArgsSchema, { decision_id: id, text: oversized })
      .success,
  ).toBe(false);
});
