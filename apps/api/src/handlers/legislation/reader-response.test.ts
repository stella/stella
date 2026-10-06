import { Value } from "@sinclair/typebox/value";
import { expect, test } from "bun:test";
import Elysia, { t } from "elysia";
import fc from "fast-check";

import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import {
  projectStatuteReader,
  projectStatuteVersion,
  projectProvisionHistoryItem,
  projectProvisionPreview,
  statuteReaderSuccessResponseSchema,
  statuteVersionsSuccessResponseSchema,
  provisionHistorySuccessResponseSchema,
  provisionPreviewSuccessResponseSchema,
  readerTextBytes,
  PREVIEW_BLOCK_MAX,
  PREVIEW_HEADING_MAX,
} from "@/api/handlers/legislation/reader-response";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedLegislationDocumentId } from "@/api/lib/safe-id-boundaries";
import { responseSchemaByteBound } from "@/api/tests/helpers/response-schema-byte-bound";

const id = brandPersistedLegislationDocumentId(
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
);
const hostileText = fc
  .array(
    fc.constantFrom(
      "ř",
      "😀",
      "\u0000",
      "\ud800",
      '"',
      "\\",
      "&amp;",
      "&#x1f600;",
    ),
    { minLength: 1, maxLength: 30 },
  )
  .map((parts) => parts.join(""));
const version = (text: string) =>
  ({
    id,
    eli: text,
    slug: text,
    title: text,
    country: text,
    language: text,
    documentType: text,
    status: text,
    effectiveDate: text,
    versionValidFrom: text,
    versionValidTo: text,
    expressionKind: "consolidation",
    windowDisposition: "effective",
    windowDispositionBasis: null,
    sourceUrl: text,
    documentUrl: text,
    isDefault: true,
  }) as const;

test("reader metadata is byte bounded while complete official text survives", () => {
  assertProperty(
    "reader metadata is byte bounded while complete official text survives",
    fc.property(hostileText, (fragment) => {
      const text = fragment.repeat(8000);
      const { isDefault: _isDefault, ...metadata } = version(text);
      const body = {
        ...metadata,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        citationCaseCount: 0,
        allowsDerivedAi: true,
        sections: [{ index: 0, type: "unknown" as const, title: text, text }],
        documentAst: {},
        fulltext: text,
      };
      const result = projectStatuteReader(body);
      expect(Value.Check(statuteReaderSuccessResponseSchema, result)).toBe(
        true,
      );
      expect(result.fulltext).toBe(text);
      expect(result.documentAst).toBe(body.documentAst);
      expect(result.sections?.at(0)?.text).toBe(text);
      const envelope = {
        ...result,
        fulltext: null,
        documentAst: null,
        sections: result.sections?.map((section) => ({ ...section, text: "" })),
      };
      const metadataSchema = t.Omit(statuteReaderSuccessResponseSchema, [
        "fulltext",
        "documentAst",
        "sections",
      ]);
      const sectionSchema =
        statuteReaderSuccessResponseSchema.properties.sections.anyOf[0].items;
      const projectedSectionSchema = t.Omit(sectionSchema, ["text"]);
      const metadataEnvelope = { ...envelope, sections: undefined };
      const metadataBytes = Buffer.byteLength(JSON.stringify(metadataEnvelope));
      const section = result.sections?.at(0);
      expect(metadataBytes).toBeLessThanOrEqual(
        responseSchemaByteBound(metadataSchema),
      );
      expect(
        Buffer.byteLength(
          JSON.stringify({
            index: section?.index,
            type: section?.type,
            title: section?.title,
          }),
        ),
      ).toBeLessThanOrEqual(responseSchemaByteBound(projectedSectionSchema));
    }),
  );
});

test("version pages serialize within the bound derived from every metadata field", () => {
  assertProperty(
    "version pages serialize within the bound derived from every metadata field",
    fc.property(hostileText, (fragment) => {
      const text = fragment.repeat(8000);
      const count = LIMITS.legislationVersionsPageSizeMax;
      const item = projectStatuteVersion(version(text));
      const result = {
        items: Array.from({ length: count }, () => item),
        limit: count,
        nextCursor: "x".repeat(readerTextBytes.cursor),
      };
      expect(Value.Check(statuteVersionsSuccessResponseSchema, result)).toBe(
        true,
      );
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        responseSchemaByteBound(statuteVersionsSuccessResponseSchema),
      );
    }),
  );
});

test("provision history pages keep each preview wording inside its byte budget", () => {
  assertProperty(
    "provision history pages keep each preview wording inside its byte budget",
    fc.property(hostileText, (fragment) => {
      const text = fragment.repeat(8000);
      const row = {
        documentId: id,
        allowsDerivedAi: true,
        versionValidFrom: text,
        versionValidTo: text,
        expressionKind: "consolidation",
        windowDisposition: "effective",
        windowDispositionBasis: null,
        text,
      } as const;
      const count = LIMITS.legislationProvisionHistoryPageSizeMax;
      const item = projectProvisionHistoryItem({
        ...row,
        country: "CZE",
        slug: "89-2012-sb",
        sourceUrl: "https://www.e-sbirka.cz/sb/2012/89",
      });
      const result = {
        items: Array.from({ length: count }, () => item),
        limit: count,
        nextCursor: "x".repeat(readerTextBytes.cursor),
      };
      expect(Value.Check(provisionHistorySuccessResponseSchema, result)).toBe(
        true,
      );
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        responseSchemaByteBound(provisionHistorySuccessResponseSchema),
      );
    }),
  );
});

test("citation previews cap block count and serialize within their derived byte budget", () => {
  assertProperty(
    "citation previews cap block count and serialize within their derived byte budget",
    fc.property(hostileText, (fragment) => {
      const text = fragment.repeat(8000);
      const heading = { id: text, anchorId: text, level: 1 as const, text };
      const result = projectProvisionPreview({
        documentId: id,
        language: text,
        anchorId: text,
        citedAnchorId: text,
        headings: Array.from(
          { length: PREVIEW_HEADING_MAX + 1 },
          () => heading,
        ),
        heading,
        blocks: Array.from({ length: PREVIEW_BLOCK_MAX + 1 }, () => ({
          id: text,
          anchorId: text,
          text,
        })),
      });
      expect(Value.Check(provisionPreviewSuccessResponseSchema, result)).toBe(
        true,
      );
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        responseSchemaByteBound(provisionPreviewSuccessResponseSchema),
      );
    }),
  );
});

test("reader plain text keeps literal markup and entities as text", () => {
  assertProperty(
    "reader plain text keeps literal markup and entities as text",
    fc.property(
      fc.array(fc.constantFrom("<mark>", "</mark>", "&amp;", "x", "ř"), {
        minLength: 1,
        maxLength: 40,
      }),
      fc.integer({ min: 1, max: 4000 }),
      (tokens, repeat) => {
        const text = tokens.join("").repeat(repeat);
        const preview = projectProvisionPreview({
          documentId: id,
          language: "cs",
          anchorId: "par_1",
          citedAnchorId: null,
          headings: [],
          heading: null,
          blocks: [{ id: "1", anchorId: "par_1", text }],
        }).blocks.at(0)?.text;
        const history = projectProvisionHistoryItem({
          country: "CZE",
          slug: "89-2012-sb",
          sourceUrl: "https://www.e-sbirka.cz/sb/2012/89",
          documentId: id,
          allowsDerivedAi: true,
          versionValidFrom: null,
          versionValidTo: null,
          expressionKind: "consolidation",
          windowDisposition: "effective",
          windowDispositionBasis: null,
          text,
        }).text;
        for (const [projected, maxBytes] of [
          [preview, readerTextBytes.previewText],
          [history, readerTextBytes.provisionText],
        ] as const) {
          expect(text.startsWith(projected ?? "")).toBe(true);
          expect(Buffer.byteLength(projected ?? "")).toBeLessThanOrEqual(
            maxBytes,
          );
          if (Buffer.byteLength(text) <= maxBytes) {
            expect(projected).toBe(text);
          }
        }
      },
    ),
  );
});

test("reader response serialization preserves the complete official AST and text while bounding metadata", async () => {
  const officialText = "§ 1 Řádné znění zákona 👩‍⚖️ &amp; ".repeat(10_000);
  const documentAst = {
    version: 1,
    source: {
      system: "official-publisher",
      documentId: "act-1",
      webUrl: "https://example.test/act/1",
      printUrl: "https://example.test/act/1/print",
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
        id: "paragraph-1",
        anchorId: "par_1",
        type: "paragraph",
        inlines: [{ type: "text", text: officialText }],
        plainText: officialText,
      },
    ],
  } satisfies DocumentAst;
  const { isDefault: _isDefault, ...metadata } = version(officialText);
  const projected = projectStatuteReader({
    ...metadata,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    citationCaseCount: 0,
    allowsDerivedAi: true,
    documentAst,
    fulltext: officialText,
    sections: [
      { index: 0, type: "unknown", title: officialText, text: officialText },
    ],
  });
  expect(Buffer.byteLength(officialText)).toBeGreaterThan(
    readerTextBytes.provisionText,
  );
  expect(Buffer.byteLength(projected.title)).toBeLessThanOrEqual(
    readerTextBytes.title,
  );
  expect(
    Buffer.byteLength(projected.sections?.at(0)?.title ?? ""),
  ).toBeLessThanOrEqual(readerTextBytes.sectionTitle);
  const app = new Elysia().get("/statute", () => projected, {
    response: { 200: statuteReaderSuccessResponseSchema },
  });
  const response = await app.handle(new Request("http://localhost/statute"));
  expect(response.status).toBe(200);
  // Compare the actual wire object, including all inline text, to the complete
  // source fixture: schema encoding must not clean or narrow the AST payload.
  expect(await response.json()).toEqual({
    ...projected,
    documentAst,
    fulltext: officialText,
    sections: [
      {
        index: 0,
        type: "unknown",
        title: projected.sections?.at(0)?.title,
        text: officialText,
      },
    ],
  });
});
