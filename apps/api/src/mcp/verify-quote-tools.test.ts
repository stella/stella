import { expect, test } from "bun:test";
import * as v from "valibot";

import { DECISION_READ_RESOLUTION } from "@stll/api-contract/case-law-decision-resolution";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { status } from "@/api/http/status";
import { createSafeId } from "@/api/lib/branded-types";
import { readDecisionTextMetadata } from "@/api/lib/case-law/decision-text";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import type { ReadCaseLawDecisionSuccess } from "./public-law-handlers";
import {
  VERIFY_QUOTE_TOOL_SET,
  verifyQuoteArgsSchema,
  verifyQuoteOutputSchema,
} from "./verify-quote-tools";

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

type ToolContext = Parameters<
  typeof VERIFY_QUOTE_TOOL_SET.handlers.verify_quote
>[0]["context"];
type Dependencies = NonNullable<ToolContext["testDependencies"]>;
const call = async (
  read: Awaited<
    ReturnType<NonNullable<Dependencies["readGatedDecisionWithDocument"]>>
  >,
  text = "Soud návrh zamítl",
) => {
  let calls = 0;
  const testDependencies = {
    readsSharedPublicLawCorpus: () => false,
    readGatedDecisionWithDocument: async (options) => {
      calls += 1;
      expect(options.documentHydration).toEqual({ type: "stored-only" });
      return read;
    },
  } satisfies Dependencies;
  const response = await VERIFY_QUOTE_TOOL_SET.handlers.verify_quote({
    args: { decision_id: id, text },
    context: asTestRaw<ToolContext>({ testDependencies }),
  });
  expect(calls).toBe(1);
  if ("egress" in response) {
    throw new TypeError("Quote tool returns a typed data outcome");
  }
  if (response.status === "success") {
    return {
      ...response,
      data: v.parse(verifyQuoteOutputSchema, response.data),
    };
  }
  return response;
};

test("the real tool schema accepts quote requests and rejects malformed ids and empty ellipses", async () => {
  expect(
    v.safeParse(verifyQuoteArgsSchema, {
      decision_id: id,
      text: "Soud návrh zamítl",
    }).success,
  ).toBe(true);
  for (const args of [
    { decision_id: "invalid", text: "quote" },
    { decision_id: id, text: "[…]" },
  ]) {
    const response = await VERIFY_QUOTE_TOOL_SET.handlers.verify_quote({
      args,
      context: asTestRaw<ToolContext>({}),
    });
    expect(response).toMatchObject({
      status: "error",
      error: { code: "validation_error" },
    });
    if (
      !("egress" in response) &&
      response.status === "error" &&
      response.error.type === "structured"
    ) {
      expect(response.error.hint).toContain("verify_quote");
    }
  }
});

test("only an exact tool outcome verifies a quote; fuzzy exposes alterations", async () => {
  const exact = await call(readOf());
  expect(exact).toMatchObject({
    status: "success",
    data: { status: "exact", verified: true, textSource: "fulltext" },
  });
  const fuzzy = await call(
    readOf(),
    "Soud návrh přijal pro opožděnost podání.",
  );
  expect(fuzzy).toMatchObject({
    status: "success",
    data: { status: "fuzzy", verified: false },
  });
  if (fuzzy.status !== "success" || fuzzy.data.status !== "fuzzy") {
    return;
  }
  expect(
    fuzzy.data.segments
      .at(0)
      ?.closest?.differences.some(({ type }) => type === "added"),
  ).toBe(true);
  expect(
    exact.status === "success" &&
      exact.data.status === "exact" &&
      exact.data.segments.at(0)?.occurrences.at(0)?.paragraphs.at(0)?.position,
  ).toBe(1);
});

test("unreadable text never becomes a negative quote verdict", async () => {
  const base = readOf();
  for (const [read, textState] of [
    [{ ...base, documentPending: true, fulltext: null }, "pending"],
    [
      { ...base, documentPending: true, documentUrl: null, fulltext: null },
      "unavailable",
    ],
    [{ ...base, documentReadFailed: true, fulltext: null }, "failed"],
    [
      { ...base, source: { ...base.source, allowsDerivedAi: false } },
      "withheld",
    ],
    [{ ...base, fulltext: "" }, "empty"],
  ] as const) {
    expect(await call(read)).toMatchObject({
      status: "success",
      data: { status: "cannot_verify", verified: false, textState },
    });
  }
});

test("unknown ids and backing read failures have distinct actionable error envelopes", async () => {
  expect(await call(null)).toMatchObject({
    status: "error",
    error: { code: "not_found" },
  });
  expect(
    await call(status(404, { message: "Decision not found" })),
  ).toMatchObject({ status: "error", error: { code: "not_found" } });
  expect(await call(status(400, { message: "Invalid cursor" }))).toMatchObject({
    status: "error",
    error: { code: "upstream_unavailable" },
  });
});

test("the advertised contract requires altered quotes to remain unconfirmed", () => {
  expect(VERIFY_QUOTE_TOOL_SET.definitions.at(0)?.description).toContain(
    "Report fuzzy as an altered quote, never confirmed",
  );
});
