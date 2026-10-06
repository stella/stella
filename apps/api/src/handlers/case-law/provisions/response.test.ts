import { Value } from "@sinclair/typebox/value";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { listCitingDecisionsHandler } from "@/api/handlers/case-law/provisions/citing-decisions";
import type { listDecisionProvisionsHandler } from "@/api/handlers/case-law/provisions/list-for-decision";
import { toSafeId } from "@/api/lib/branded-types";
import { projectResponseText } from "@/api/lib/search/project-response-text";
import { responseByteBound } from "@/api/lib/search/response-byte-bound";

import { projectProvisionPreview } from "./response";
import {
  citationCountsSuccessResponseSchema,
  citingDecisionsSuccessResponseSchema,
  decisionProvisionsSuccessResponseSchema,
  PROVISION_PREVIEW_BLOCKS_MAX,
} from "./response-schema";

const unicode = fc
  .array(fc.constantFrom("ě", "😀", "e\u0301", "\u0000", '"', "\\", "\ud800"), {
    minLength: 1,
    maxLength: 16,
  })
  .map((parts) => parts.join(""));

const provisionItem = (text: string) =>
  ({
    jurisdiction: text,
    workIdentifier: text,
    workNumber: 89,
    workYear: 2012,
    workCollection: text,
    workEli: text,
    workSource: "number",
    unit: "section",
    section: 1,
    sectionSuffix: text,
    subsection: text,
    letter: text,
    point: text,
    sentence: text,
    openEnded: false,
    anchor: text,
    versionValidFrom: text,
    versionBasis: { type: "inferred", kind: "decision_date" },
    inferredVersionCandidate: {
      type: "inferred",
      kind: "decision_date",
      versionValidFrom: text,
    },
    sentenceText: text,
    spanStart: 0,
    spanEnd: 10,
    confidence: 1,
    spanRole: "printed",
    printPieceId: text,
    printStart: 0,
    printEnd: 10,
    printText: text,
    namePieceId: text,
    nameStart: 0,
    nameEnd: 10,
    nameText: text,
    selection: "text",
    printedWorkIdentifier: text,
    targetDocumentId: null,
    targetStatus: "available",
  }) as const satisfies Extract<
    Awaited<ReturnType<typeof listDecisionProvisionsHandler>>,
    { items: unknown[] }
  >["items"][number];

const citingItem = (text: string) =>
  ({
    decisionId: toSafeId<"caseLawDecision">(
      "00000000-0000-4000-8000-000000000001",
    ),
    caseNumber: text,
    slug: text,
    court: text,
    courtAbbreviation: null,
    courtTier: "other",
    mentionCount: 1,
    snippetCitation: null,
    country: text,
    language: text,
    decisionDate: text,
    versionValidFrom: text,
    versionBasis: { type: "inferred", kind: "decision_date" },
    inferredVersionCandidate: {
      type: "inferred",
      kind: "decision_date",
      versionValidFrom: text,
    },
    citationAuthority: 1,
    sentenceText: text,
    spanStart: 0,
    spanEnd: 10,
    languageAlternates: [],
  }) satisfies Extract<
    Awaited<ReturnType<typeof listCitingDecisionsHandler>>,
    { items: unknown[] }
  >["items"][number];

test("public decision provision previews bound serialized Unicode and disclose display truncation", () => {
  assertProperty(
    "public decision provision previews bound serialized Unicode and disclose display truncation",
    fc.property(unicode, (part) => {
      const text = part.repeat(16_385);
      const preview = projectProvisionPreview({
        key: "preview",
        documentId: toSafeId<"legislationDocument">(
          "00000000-0000-4000-8000-000000000001",
        ),
        language: text,
        anchorId: text,
        citedAnchorId: text,
        headings: [{ anchorId: text, level: 1, text }],
        heading: { id: text, anchorId: text, level: 1, text },
        blocks: Array.from(
          { length: PROVISION_PREVIEW_BLOCKS_MAX + 1 },
          () => ({ id: text, anchorId: text, text }),
        ),
      });
      const input = {
        items: [{ ...provisionItem(text), previewKey: "preview" }],
        limit: 1,
        nextCursor: null,
        status: { type: "current" },
        generation: "1",
        publishedProjectionDigest: null,
        previews: [preview],
      };
      const output = projectResponseText(
        input,
        decisionProvisionsSuccessResponseSchema,
      );
      expect(preview.truncated).toBe(true);
      expect(Value.Check(decisionProvisionsSuccessResponseSchema, output)).toBe(
        true,
      );
      expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(
        responseByteBound(decisionProvisionsSuccessResponseSchema),
      );
      expect(input.items.at(0)?.sentenceText).toBe(text);
    }),
    { numRuns: 12 },
  );
});

test("public provision citing decisions bound serialized Unicode and retain withheld excerpts", () => {
  assertProperty(
    "public provision citing decisions bound serialized Unicode and retain withheld excerpts",
    fc.property(unicode, (part) => {
      const text = part.repeat(16_385);
      const input = {
        items: [citingItem(text), { ...citingItem(text), sentenceText: null }],
        snapshot: null,
        nextCursor: null,
        limit: 2,
      };
      const output = projectResponseText(
        input,
        citingDecisionsSuccessResponseSchema,
      );
      expect(Value.Check(citingDecisionsSuccessResponseSchema, output)).toBe(
        true,
      );
      expect(output.items.at(1)?.sentenceText).toBeNull();
      expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(
        responseByteBound(citingDecisionsSuccessResponseSchema),
      );
    }),
    { numRuns: 12 },
  );
});

test("public provision citation counts bound serialized Unicode anchors", () => {
  assertProperty(
    "public provision citation counts bound serialized Unicode anchors",
    fc.property(unicode, (part) => {
      const input = {
        status: "ready",
        provisions: [{ anchor: part.repeat(1025), decisionCount: 1 }],
      };
      const output = projectResponseText(
        input,
        citationCountsSuccessResponseSchema,
      );
      expect(Value.Check(citationCountsSuccessResponseSchema, output)).toBe(
        true,
      );
      expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(
        responseByteBound(citationCountsSuccessResponseSchema),
      );
    }),
    { numRuns: 12 },
  );
});

test("provision reads require an explicit version basis", () => {
  const provision = { ...provisionItem("text"), previewKey: null };
  const decisionPage = {
    items: [provision],
    limit: 1,
    nextCursor: null,
    status: { type: "legacy" },
    generation: "0",
    publishedProjectionDigest: null,
    previews: [],
  };
  const citingPage = {
    items: [citingItem("text")],
    snapshot: null,
    limit: 1,
    nextCursor: null,
  };
  expect(
    Value.Check(decisionProvisionsSuccessResponseSchema, decisionPage),
  ).toBe(true);
  expect(Value.Check(citingDecisionsSuccessResponseSchema, citingPage)).toBe(
    true,
  );
  for (const versionBasis of [
    undefined,
    { type: "stated" },
    { type: "inferred", kind: "unknown" },
  ]) {
    expect(
      Value.Check(decisionProvisionsSuccessResponseSchema, {
        ...decisionPage,
        items: [{ ...provision, versionBasis }],
      }),
    ).toBe(false);
    expect(
      Value.Check(citingDecisionsSuccessResponseSchema, {
        ...citingPage,
        items: [{ ...citingItem("text"), versionBasis }],
      }),
    ).toBe(false);
  }
});
