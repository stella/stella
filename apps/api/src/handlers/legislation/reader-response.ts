import { t } from "elysia";
import type { Static } from "elysia";
import * as v from "valibot";

import {
  LEGISLATION_EXPRESSION_KINDS,
  LEGISLATION_WINDOW_DISPOSITIONS,
  LEGISLATION_WINDOW_DISPOSITION_BASIS_VALUES,
} from "@stll/api-contract/legislation-expression";
import { documentAstSchema } from "@stll/legal-ast/document-ast";

import { tSafeId } from "@/api/lib/custom-schema";
import {
  DECISION_SECTION_TYPES,
  emptyAstSchema,
} from "@/api/lib/legal-search/document-types";
import type { ProvisionPreview } from "@/api/lib/legal-search/legislation-provision-preview";
import { LIMITS } from "@/api/lib/limits";
import {
  boundedString,
  nullableBoundedString,
  truncateTextBytes,
  nullableText,
} from "@/api/lib/search/response-text-bounds";

// Database varchar limits admit four UTF-8 bytes per character; text columns
// have explicit display budgets. Whole reader wording is preserved below.
export const readerTextBytes = {
  ...LIMITS.legislationSearchTextBytes,
  versionValidFrom: 32,
  versionValidTo: 32,
  documentUrl: 2048 * 4,
  sectionTitle: 4096,
  anchor: 256 * 4,
  blockId: 256 * 4,
  heading: 4096,
  provisionText: 64 * 1024,
  previewText: 4096,
  cursor: 256,
};

export const PREVIEW_BLOCK_MAX = 32;
export const PREVIEW_HEADING_MAX = 6;
const closed = { additionalProperties: false };
const labelFields = {
  expressionKind: t.UnionEnum(LEGISLATION_EXPRESSION_KINDS),
  windowDisposition: t.UnionEnum(LEGISLATION_WINDOW_DISPOSITIONS),
  windowDispositionBasis: t.Union([
    t.UnionEnum(LEGISLATION_WINDOW_DISPOSITION_BASIS_VALUES),
    t.Null(),
  ]),
};
const windowFields = {
  versionValidFrom: nullableBoundedString(readerTextBytes.versionValidFrom),
  versionValidTo: nullableBoundedString(readerTextBytes.versionValidTo),
  ...labelFields,
};
const versionFields = {
  id: tSafeId("legislationDocument"),
  eli: boundedString(readerTextBytes.eli),
  slug: nullableBoundedString(readerTextBytes.slug),
  title: boundedString(readerTextBytes.title),
  country: boundedString(readerTextBytes.country),
  language: boundedString(readerTextBytes.language),
  documentType: nullableBoundedString(readerTextBytes.documentType),
  status: boundedString(readerTextBytes.status),
  effectiveDate: nullableBoundedString(readerTextBytes.effectiveDate),
  ...windowFields,
  sourceUrl: nullableBoundedString(readerTextBytes.sourceUrl),
  documentUrl: nullableBoundedString(readerTextBytes.documentUrl),
};
const statuteVersionSchema = t.Object(
  { ...versionFields, isDefault: t.Boolean() },
  closed,
);
export const statuteVersionsSuccessResponseSchema = t.Object(
  {
    items: t.Array(statuteVersionSchema, {
      maxItems: LIMITS.legislationVersionsPageSizeMax,
    }),
    limit: t.Number(),
    nextCursor: nullableBoundedString(readerTextBytes.cursor),
  },
  closed,
);

export const statuteReaderSuccessResponseSchema = t.Object(
  {
    ...versionFields,
    createdAt: boundedString(32),
    updatedAt: boundedString(32),
    citationCaseCount: t.Union([t.Number(), t.Null()]),
    allowsDerivedAi: t.Boolean(),
    sections: t.Union([
      t.Array(
        t.Object(
          {
            index: t.Number(),
            type: t.UnionEnum(DECISION_SECTION_TYPES),
            title: nullableBoundedString(readerTextBytes.sectionTitle),
            text: t.String(),
          },
          closed,
        ),
      ),
      t.Null(),
    ]),
    // The reader deliberately returns the complete official document AST/text.
    documentAst: t
      .Transform(t.Unknown())
      .Decode((value) =>
        v.parse(
          v.nullable(v.union([documentAstSchema, emptyAstSchema])),
          value,
        ),
      )
      .Encode((value) => value),
    fulltext: t.Union([t.String(), t.Null()]),
  },
  closed,
);

const provisionHistoryItemSchema = t.Object(
  {
    country: boundedString(readerTextBytes.country),
    slug: nullableBoundedString(readerTextBytes.slug),
    sourceUrl: nullableBoundedString(readerTextBytes.sourceUrl),
    documentId: tSafeId("legislationDocument"),
    allowsDerivedAi: t.Boolean(),
    ...windowFields,
    text: boundedString(readerTextBytes.provisionText),
  },
  closed,
);
export const provisionHistorySuccessResponseSchema = t.Object(
  {
    items: t.Array(provisionHistoryItemSchema, {
      maxItems: LIMITS.legislationProvisionHistoryPageSizeMax,
    }),
    limit: t.Number(),
    nextCursor: nullableBoundedString(readerTextBytes.cursor),
  },
  closed,
);
const headingFields = {
  anchorId: boundedString(readerTextBytes.anchor),
  level: t.UnionEnum([1, 2, 3, 4, 5, 6]),
  text: boundedString(readerTextBytes.heading),
};
export const provisionPreviewSuccessResponseSchema = t.Object(
  {
    documentId: tSafeId("legislationDocument"),
    language: boundedString(readerTextBytes.language),
    anchorId: boundedString(readerTextBytes.anchor),
    citedAnchorId: nullableBoundedString(readerTextBytes.anchor),
    headings: t.Array(t.Object(headingFields, closed), {
      maxItems: PREVIEW_HEADING_MAX,
    }),
    heading: t.Union([
      t.Object(
        { id: boundedString(readerTextBytes.blockId), ...headingFields },
        closed,
      ),
      t.Null(),
    ]),
    blocks: t.Array(
      t.Object(
        {
          id: boundedString(readerTextBytes.blockId),
          anchorId: boundedString(readerTextBytes.anchor),
          text: boundedString(readerTextBytes.previewText),
        },
        closed,
      ),
      { maxItems: PREVIEW_BLOCK_MAX },
    ),
  },
  closed,
);

type Version = Static<typeof statuteVersionSchema>;
export const projectStatuteVersion = (row: Version): Version => ({
  id: row.id,
  expressionKind: row.expressionKind,
  windowDisposition: row.windowDisposition,
  windowDispositionBasis: row.windowDispositionBasis,
  isDefault: row.isDefault,
  eli: truncateTextBytes(row.eli, readerTextBytes.eli),
  slug: nullableText(row.slug, readerTextBytes.slug),
  title: truncateTextBytes(row.title, readerTextBytes.title),
  country: truncateTextBytes(row.country, readerTextBytes.country),
  language: truncateTextBytes(row.language, readerTextBytes.language),
  documentType: nullableText(row.documentType, readerTextBytes.documentType),
  status: truncateTextBytes(row.status, readerTextBytes.status),
  effectiveDate: nullableText(row.effectiveDate, readerTextBytes.effectiveDate),
  versionValidFrom: nullableText(
    row.versionValidFrom,
    readerTextBytes.versionValidFrom,
  ),
  versionValidTo: nullableText(
    row.versionValidTo,
    readerTextBytes.versionValidTo,
  ),
  sourceUrl: nullableText(row.sourceUrl, readerTextBytes.sourceUrl),
  documentUrl: nullableText(row.documentUrl, readerTextBytes.documentUrl),
});

type Reader = Static<typeof statuteReaderSuccessResponseSchema>;
type ReaderRow = Omit<Reader, "createdAt" | "updatedAt"> & {
  createdAt: Date;
  updatedAt: Date;
};
export const projectStatuteReader = (row: ReaderRow): Reader => {
  const { isDefault: _isDefault, ...metadata } = projectStatuteVersion({
    ...row,
    isDefault: false,
  });
  return {
    ...metadata,
    documentAst: row.documentAst,
    fulltext: row.fulltext,
    citationCaseCount: row.citationCaseCount,
    allowsDerivedAi: row.allowsDerivedAi,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    sections:
      row.sections?.map((section) => ({
        index: section.index,
        type: section.type,
        text: section.text,
        title: nullableText(section.title, readerTextBytes.sectionTitle),
      })) ?? null,
  };
};

type HistoryItem = Static<typeof provisionHistoryItemSchema>;
export const projectProvisionHistoryItem = (row: HistoryItem): HistoryItem => ({
  country: truncateTextBytes(row.country, readerTextBytes.country),
  slug: nullableText(row.slug, readerTextBytes.slug),
  sourceUrl: nullableText(row.sourceUrl, readerTextBytes.sourceUrl),
  documentId: row.documentId,
  allowsDerivedAi: row.allowsDerivedAi,
  expressionKind: row.expressionKind,
  windowDisposition: row.windowDisposition,
  windowDispositionBasis: row.windowDispositionBasis,
  versionValidFrom: nullableText(
    row.versionValidFrom,
    readerTextBytes.versionValidFrom,
  ),
  versionValidTo: nullableText(
    row.versionValidTo,
    readerTextBytes.versionValidTo,
  ),
  text: truncateTextBytes(row.text, readerTextBytes.provisionText),
});

export const projectProvisionPreview = (preview: ProvisionPreview) => ({
  documentId: preview.documentId,
  language: truncateTextBytes(preview.language, readerTextBytes.language),
  anchorId: truncateTextBytes(preview.anchorId, readerTextBytes.anchor),
  citedAnchorId: nullableText(preview.citedAnchorId, readerTextBytes.anchor),
  headings: preview.headings.slice(0, PREVIEW_HEADING_MAX).map((heading) => ({
    level: heading.level,
    anchorId: truncateTextBytes(heading.anchorId, readerTextBytes.anchor),
    text: truncateTextBytes(heading.text, readerTextBytes.heading),
  })),
  heading:
    preview.heading === null
      ? null
      : {
          level: preview.heading.level,
          id: truncateTextBytes(preview.heading.id, readerTextBytes.blockId),
          anchorId: truncateTextBytes(
            preview.heading.anchorId,
            readerTextBytes.anchor,
          ),
          text: truncateTextBytes(
            preview.heading.text,
            readerTextBytes.heading,
          ),
        },
  blocks: preview.blocks.slice(0, PREVIEW_BLOCK_MAX).map((block) => ({
    id: truncateTextBytes(block.id, readerTextBytes.blockId),
    anchorId: truncateTextBytes(block.anchorId, readerTextBytes.anchor),
    text: truncateTextBytes(block.text, readerTextBytes.previewText),
  })),
});
