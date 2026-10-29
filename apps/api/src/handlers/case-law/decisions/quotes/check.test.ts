import { expect, test } from "bun:test";
import * as v from "valibot";

import { DECISION_READ_RESOLUTION } from "@stll/api-contract/case-law-decision-resolution";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { createSafeId } from "@/api/lib/branded-types";
import { readDecisionTextMetadata } from "@/api/lib/case-law/decision-text";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import type { ReadCaseLawDecisionSuccess } from "@/api/mcp/public-law-handlers";
import { verifyQuoteOutputSchema } from "@/api/mcp/verify-quote-tools";
import { serveForTest } from "@/api/tests/helpers/test-server";

import { createVerifyQuotationHandler } from "./check";

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
  }) satisfies ReadCaseLawDecisionSuccess;

type QuoteRead = Awaited<
  ReturnType<
    NonNullable<
      NonNullable<
        Parameters<typeof createVerifyQuotationHandler>[0]
      >["readDecision"]
    >
  >
>;
const requestQuote = async (read: QuoteRead, quote: string) => {
  let reads = 0;
  const endpoint = createVerifyQuotationHandler({
    readSharedCorpus: () => false,
    readDecision: async (options) => {
      reads += 1;
      expect(options.locator).toEqual({ kind: "id", id });
      expect(options.caller).toBe("anonymous");
      expect(options.documentHydration).toEqual({ type: "stored-only" });
      return read;
    },
  });
  const server = serveForTest(
    createHttpApp({
      routes: routes({ "/case/decisions/quotes/verify": { POST: endpoint } }),
      middleware: [errorBoundary],
    }),
  );
  const response = await server.fetch(
    new Request("http://localhost/case/decisions/quotes/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision_id: id, text: quote }),
    }),
  );
  const body: unknown = await response.json();
  await server.stop();
  expect(reads).toBe(1);
  return { status: response.status, body };
};

test("the quote endpoint verifies exact text and exposes fuzzy alterations", async () => {
  expect(await requestQuote(readOf(), "Soud návrh zamítl")).toMatchObject({
    status: 200,
    body: {
      status: "exact",
      verified: true,
      decisionId: id,
      textSource: "fulltext",
    },
  });
  const fuzzy = await requestQuote(
    readOf(),
    "Soud návrh přijal pro opožděnost podání.",
  );
  expect(fuzzy).toMatchObject({
    status: 200,
    body: { status: "fuzzy", verified: false },
  });
  const parsed = v.parse(verifyQuoteOutputSchema, fuzzy.body);
  if (parsed.status === "fuzzy") {
    expect(parsed.segments.at(0)?.closest?.differences).toContainEqual({
      type: "added",
      words: ["přijal"],
    });
  }
});

test("the quote endpoint distinguishes absent quotes from unknown decisions", async () => {
  expect(
    await requestQuote(readOf(), "Zcela odlišná citace právního závěru."),
  ).toMatchObject({
    status: 200,
    body: { status: "not_found", verified: false },
  });
  expect(await requestQuote(null, "Soud návrh zamítl")).toEqual({
    status: 404,
    body: { message: "Decision not found" },
  });
});

test("the quote endpoint returns cannot_verify for unreadable decisions", async () => {
  expect(
    await requestQuote(
      { ...readOf(), documentReadFailed: true, fulltext: null },
      "Soud návrh zamítl",
    ),
  ).toMatchObject({
    status: 200,
    body: { status: "cannot_verify", verified: false, textState: "failed" },
  });
});
