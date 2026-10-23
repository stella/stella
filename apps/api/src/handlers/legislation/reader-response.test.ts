import { expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import {
  isEligibleLegislationExpression,
  LEGISLATION_EXPRESSION_KINDS,
  LEGISLATION_WINDOW_DISPOSITIONS,
} from "@stll/api-contract/legislation-expression";
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import {
  PREVIEW_BLOCK_MAX,
  PREVIEW_HEADING_MAX,
  projectProvisionHistoryItem,
  projectProvisionPreview,
  projectStatuteAmendments,
  projectStatuteReader,
  projectStatuteVersion,
  provisionHistorySuccessResponseSchema,
  provisionPreviewSuccessResponseSchema,
  readerTextBytes,
  statuteReaderSuccessResponseSchema,
  statuteVersionsSuccessResponseSchema,
} from "@/api/handlers/legislation/reader-response";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { createSafeId } from "@/api/lib/branded-types";
import { toRouteJsonSchema } from "@/api/lib/json-schema/valibot-to-json-schema";
import { effectOpensVersion } from "@/api/lib/legal-search/legislation-validity-window";
import { LIMITS } from "@/api/lib/limits";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { brandPersistedLegislationDocumentId } from "@/api/lib/safe-id-boundaries";
import { responseSchemaByteBound } from "@/api/tests/helpers/response-schema-byte-bound";
import { serveForTest } from "@/api/tests/helpers/test-server";

/** The serialized bound the response schema's JSON Schema rendering implies. */
const byteBound = (schema: v.GenericSchema) =>
  responseSchemaByteBound(toRouteJsonSchema(schema));

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
      expect(v.is(statuteReaderSuccessResponseSchema, result)).toBe(true);
      expect(result.fulltext).toBe(text);
      expect(result.documentAst).toBe(body.documentAst);
      expect(result.sections?.at(0)?.text).toBe(text);
      const envelope = {
        ...result,
        fulltext: null,
        documentAst: null,
        sections: result.sections?.map((section) => ({ ...section, text: "" })),
      };
      const metadataSchema = v.omit(statuteReaderSuccessResponseSchema, [
        "fulltext",
        "documentAst",
        "sections",
      ]);
      const sectionSchema =
        statuteReaderSuccessResponseSchema.entries.sections.options[0].item;
      const projectedSectionSchema = v.omit(sectionSchema, ["text"]);
      const metadataEnvelope = { ...envelope, sections: undefined };
      const metadataBytes = Buffer.byteLength(JSON.stringify(metadataEnvelope));
      const section = result.sections?.at(0);
      expect(metadataBytes).toBeLessThanOrEqual(byteBound(metadataSchema));
      expect(
        Buffer.byteLength(
          JSON.stringify({
            index: section?.index,
            type: section?.type,
            title: section?.title,
          }),
        ),
      ).toBeLessThanOrEqual(byteBound(projectedSectionSchema));
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
      expect(v.is(statuteVersionsSuccessResponseSchema, result)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        byteBound(statuteVersionsSuccessResponseSchema),
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
      expect(v.is(provisionHistorySuccessResponseSchema, result)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        byteBound(provisionHistorySuccessResponseSchema),
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
      expect(v.is(provisionPreviewSuccessResponseSchema, result)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        byteBound(provisionPreviewSuccessResponseSchema),
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
  await using server = serveForTest(
    createHttpApp({
      routes: routes({
        "/statute": {
          GET: {
            access: "public",
            config: { response: { 200: statuteReaderSuccessResponseSchema } },
            run: async () => await Promise.resolve(projected),
          },
        },
      }),
      middleware: [errorBoundary],
    }),
  );
  const response = await server.fetch(new Request("http://localhost/statute"));
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

test("amendment previews preserve same-day actors, staged starts, and source gaps", () => {
  const sourceId = createSafeId<"legislationSource">();
  const relation = {
    sourceId,
    targetEli: "/eli/cz/sb/2012/89",
    language: "cs",
    publisherId: "effect-a",
    amendingEli: "/eli/cz/sb/2026/159",
    amendingTitle: "Amending act",
    amendingAnchor: null,
    affectedAnchor: "par_1830a",
    changeKind: "inserted",
    effectiveType: "date",
    effectiveDate: "2027-01-01",
    effectiveText: null,
    publisherInstruction: null,
  } as const;
  const page = {
    items: [
      relation,
      {
        ...relation,
        publisherId: "effect-b",
        amendingEli: "/eli/cz/sb/2026/160",
      },
      {
        ...relation,
        publisherId: "effect-c",
        effectiveDate: "2027-07-01",
        affectedAnchor: "par_1830b",
      },
    ],
    limit: 500,
    nextCursor: null,
  };
  const snapshot = {
    observedAt: new Date("2026-10-16T10:00:00Z"),
    coverage: {
      type: "partial",
      unlocatedRelations: 1,
      reason: "Publisher relation has no provision",
    },
  } as const;
  const result = projectStatuteAmendments({ page, snapshot });
  expect(
    result?.items.map(({ amendingEli, effectiveDate }) => [
      amendingEli,
      effectiveDate,
    ]),
  ).toEqual([
    ["/eli/cz/sb/2026/159", "2027-01-01"],
    ["/eli/cz/sb/2026/160", "2027-01-01"],
    ["/eli/cz/sb/2026/159", "2027-07-01"],
  ]);
  expect(result?.coverage).toEqual(snapshot.coverage);
  expect(projectStatuteAmendments({ page, snapshot: null })).toBeNull();
  expect(
    projectStatuteAmendments({ page: { ...page, items: [] }, snapshot })
      ?.coverage.type,
  ).toBe("partial");
  // A stored coverage carrying a key the closed response schema refuses
  // projects to its known fields only.
  const widened = {
    ...snapshot,
    coverage: { ...snapshot.coverage, publisherNote: "extra" },
  };
  expect(
    projectStatuteAmendments({ page, snapshot: widened })?.coverage,
  ).toEqual(snapshot.coverage);
});

test("effect dates label only eligible version openings across every expression state", () => {
  for (const expressionKind of LEGISLATION_EXPRESSION_KINDS) {
    for (const windowDisposition of LEGISLATION_WINDOW_DISPOSITIONS) {
      const candidate = {
        expressionKind,
        windowDisposition,
        versionValidFrom: "2027-01-01",
      };
      expect(effectOpensVersion("2027-01-01", candidate)).toBe(
        isEligibleLegislationExpression(candidate),
      );
      expect(effectOpensVersion("2027-07-01", candidate)).toBe(false);
      expect(effectOpensVersion(null, candidate)).toBe(false);
    }
  }
});
