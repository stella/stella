import { Value } from "@sinclair/typebox/value";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { DECISION_READ_RESOLUTION } from "@stll/api-contract/case-law-decision-resolution";
import { DECISION_JUDGE_ROLES } from "@stll/api-contract/case-law-judges";
import { TEXT_FIELD_TYPE } from "@stll/api-contract/case-law-text-field";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import { assertProperty } from "@stll/property-testing";

import { toSafeId } from "@/api/lib/branded-types";

import {
  DECISION_READER_NON_DOCUMENT_MAX_BYTES,
  projectDecisionReader,
  readDecisionSuccessResponseSchema,
} from "./read-response";

const UUID = "00000000-0000-4000-8000-000000000001";
const decisionId = toSafeId<"caseLawDecision">(UUID);
const sourceId = toSafeId<"caseLawSource">(UUID);
const citationId = toSafeId<"caseLawCitation">(UUID);

const decisionWithText = (text: string) => {
  const textField = { type: TEXT_FIELD_TYPE.PRESENT, text } as const;
  return {
    documentPending: false,
    hasDocument: true,
    documentReadFailed: false,
    documentUnavailable: false,
    id: decisionId,
    resolution: {
      type: DECISION_READ_RESOLUTION.ABSORBED_SUPPLEMENT,
      absorbedDecisionId: decisionId,
      anchorPrefix: text,
    },
    caseNumber: text,
    caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
    slug: text,
    ecli: text,
    identifiers: [{ type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: text }],
    court: text,
    courtId: text,
    courtAbbreviation: text,
    courtTier: "other",
    country: text,
    language: text,
    languageGroupKey: text,
    decisionDate: text,
    decisionType: text,
    documentAst: {
      version: 1,
      source: {
        system: "test",
        documentId: "decision",
        webUrl: "",
        printUrl: "",
      },
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
          id: "p-1",
          anchorId: "p-1",
          type: "paragraph",
          inlines: [{ type: "text", text }],
          plainText: text,
        },
      ],
    },
    fulltext: text,
    projectionDigest: text,
    documentAstSource: "row",
    sections: [{ index: 0, type: "header", title: text, text }],
    sourceUrl: text,
    sourceAttributionUrl: text,
    documentUrl: text,
    metadata: {
      title: text,
      nested: { values: [text, { [text]: text }] },
      deeper: { a: { b: { c: { d: { text } } } } },
      many: Array.from({ length: 256 }, () => text),
    },
    headnote: textField,
    textFields: {
      abstract: textField,
      headnote: textField,
      legalSentence: textField,
      summary: textField,
    },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    source: {
      id: sourceId,
      name: text,
      adapterKey: text,
      allowsDerivedAi: false,
    },
    judges: [
      {
        role: DECISION_JUDGE_ROLES[0],
        name: text,
        judgeId: null,
        portrait: { url: text, attribution: text },
      },
    ],
    citationsFrom: [
      {
        id: citationId,
        citationText: text,
        citedDecisionId: decisionId,
        sectionIndex: null,
      },
    ],
    citationsTo: [
      {
        id: citationId,
        citationText: text,
        citingDecisionId: decisionId,
        sectionIndex: null,
      },
    ],
    citationsNextCursor: null,
    languageAlternates: [
      {
        id: text,
        caseNumber: text,
        country: text,
        court: text,
        decisionDate: text,
        language: text,
        slug: text,
        hasDocument: true,
      },
    ],
  } satisfies Parameters<typeof projectDecisionReader>[0];
};

test("decision readers bound every non-document Unicode field and retain official text", () => {
  assertProperty(
    "decision readers bound every non-document Unicode field and retain official text",
    fc.property(
      fc.array(
        fc.constantFrom(
          "😀",
          "ř",
          "e\u0301",
          "\u0000",
          '"',
          "\\",
          "\ud800",
          "&",
        ),
        { minLength: 1, maxLength: 8 },
      ),
      (characters) => {
        const text = characters.join("").repeat(80_000);
        const original = decisionWithText(text);
        const response = projectDecisionReader(original);
        const errors = [
          ...Value.Errors(readDecisionSuccessResponseSchema, response),
        ];
        expect(errors.map(({ path, message }) => ({ path, message }))).toEqual(
          [],
        );
        expect(response.fulltext).toBe(text);
        expect(response.documentAst).toBe(original.documentAst);
        const { documentAst, fulltext, sections, ...nonDocument } = response;
        expect(documentAst).toBe(original.documentAst);
        expect(fulltext).toBe(text);
        const coordinates = (
          list: readonly { index: number; text: string }[] | null,
        ) => list?.map((section) => [section.index, section.text]);
        expect(coordinates(sections)).toEqual(coordinates(original.sections));
        expect(
          Buffer.byteLength(JSON.stringify(nonDocument)),
        ).toBeLessThanOrEqual(DECISION_READER_NON_DOCUMENT_MAX_BYTES);
      },
    ),
    { numRuns: 12 },
  );
});

test("decision readers keep every section whole so citation section indices resolve", () => {
  const sections = Array.from({ length: 300 }, (_, index) => ({
    index,
    type: "argumentation" as const,
    title: null,
    text: `${index}:${"ř".repeat(70_000)}`,
  }));
  const response = projectDecisionReader({
    ...decisionWithText("text"),
    sections,
  });

  expect(response.sections).toEqual(sections);
  expect([
    ...Value.Errors(readDecisionSuccessResponseSchema, response),
  ]).toEqual([]);
});
