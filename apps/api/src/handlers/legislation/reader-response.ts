import { panic } from "better-result";
import * as v from "valibot";

import {
  LEGISLATION_EXPRESSION_KINDS,
  LEGISLATION_WINDOW_DISPOSITION_BASIS_VALUES,
  LEGISLATION_WINDOW_DISPOSITIONS,
} from "@stll/api-contract/legislation-expression";
import { statuteChangeCountsSchema } from "@stll/api-contract/statute-version-changes";
import { documentAstSchema } from "@stll/legal-ast/document-ast";
import type { StatuteChangeCounts } from "@stll/legal-ast/statute-compare";

import type { provisionPreviewOutput } from "@/api/lib/chat/decision-reader-projections";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import {
  DECISION_SECTION_TYPES,
  emptyAstSchema,
} from "@/api/lib/legal-search/document-types";
import {
  LEGISLATION_AMENDMENT_PAGE_MAX,
  type readLegislationAmendments,
  type readLegislationAmendmentSnapshot,
} from "@/api/lib/legal-search/legislation-amendments";
import { LEGISLATION_AMENDMENT_CHANGE_KINDS } from "@/api/lib/legal-search/legislation-ingestion-types";
import type { LegislationAmendmentCoverage } from "@/api/lib/legal-search/legislation-ingestion-types";
import type { ProvisionPreview } from "@/api/lib/legal-search/legislation-provision-preview";
import { LIMITS } from "@/api/lib/limits";
import {
  boundedString,
  nullableBoundedString,
  nullableText,
  truncateTextBytes,
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
const labelFields = {
  expressionKind: v.picklist(LEGISLATION_EXPRESSION_KINDS),
  windowDisposition: v.picklist(LEGISLATION_WINDOW_DISPOSITIONS),
  windowDispositionBasis: v.union([
    v.picklist(LEGISLATION_WINDOW_DISPOSITION_BASIS_VALUES),
    v.null(),
  ]),
};
const windowFields = {
  versionValidFrom: nullableBoundedString(readerTextBytes.versionValidFrom),
  versionValidTo: nullableBoundedString(readerTextBytes.versionValidTo),
  ...labelFields,
};
const statuteAmendmentPageSchema = v.object({
  items: v.pipe(
    v.array(
      v.object({
        publisherId: boundedString(8192),
        amendingEli: boundedString(readerTextBytes.eli),
        amendingTitle: nullableBoundedString(readerTextBytes.title),
        affectedAnchor: boundedString(8192),
        changeKind: v.picklist(LEGISLATION_AMENDMENT_CHANGE_KINDS),
        effectiveDate: nullableBoundedString(32),
        effectiveText: nullableBoundedString(8192),
      }),
    ),
    v.maxLength(LEGISLATION_AMENDMENT_PAGE_MAX),
  ),
  observedAt: boundedString(32),
  coverage: v.union([
    v.object({ type: v.literal("complete") }),
    v.object({
      type: v.literal("partial"),
      unlocatedRelations: v.number(),
      reason: boundedString(8192),
    }),
    v.object({ type: v.literal("not-stated"), reason: boundedString(8192) }),
  ]),
  truncated: v.boolean(),
});

export type StatuteAmendmentPage = v.InferOutput<
  typeof statuteAmendmentPageSchema
>;

// Field by field: a stored snapshot written before its keys were closed must
// still pass the closed response schema.
const projectedCoverage = (
  coverage: LegislationAmendmentCoverage,
): StatuteAmendmentPage["coverage"] => {
  switch (coverage.type) {
    case "complete":
      return { type: "complete" };
    case "partial":
      return {
        type: "partial",
        unlocatedRelations: coverage.unlocatedRelations,
        reason: truncateTextBytes(coverage.reason, 8192),
      };
    case "not-stated":
      return {
        type: "not-stated",
        reason: truncateTextBytes(coverage.reason, 8192),
      };
    default:
      coverage satisfies never;
      return panic("Unhandled amendment coverage type");
  }
};

type ProjectStatuteAmendmentsOptions = {
  page: Awaited<ReturnType<typeof readLegislationAmendments>>;
  snapshot: Awaited<ReturnType<typeof readLegislationAmendmentSnapshot>>;
};
export const projectStatuteAmendments = ({
  page,
  snapshot,
}: ProjectStatuteAmendmentsOptions): StatuteAmendmentPage | null => {
  if (snapshot === null) {
    return null;
  }
  const coverage = snapshot.coverage;
  return {
    items: page.items.map((row) => ({
      publisherId: truncateTextBytes(row.publisherId, 8192),
      amendingEli: truncateTextBytes(row.amendingEli, readerTextBytes.eli),
      amendingTitle: nullableText(row.amendingTitle, readerTextBytes.title),
      affectedAnchor: truncateTextBytes(row.affectedAnchor, 8192),
      changeKind: row.changeKind,
      effectiveDate: row.effectiveDate,
      effectiveText: nullableText(row.effectiveText, 8192),
    })),
    observedAt: snapshot.observedAt.toISOString(),
    coverage: projectedCoverage(coverage),
    truncated: page.nextCursor !== null,
  };
};

const versionFields = {
  id: resourceIdSchema("legislationDocument"),
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
const statuteVersionSchema = v.object({
  ...versionFields,
  isDefault: v.boolean(),
  amendedBy: v.union([statuteAmendmentPageSchema, v.null()]),
  /**
   * What this consolidation changed against the eligible one before it;
   * null for the first, for one not yet counted, and for one whose wording
   * could not be compared.
   */
  changes: v.union([statuteChangeCountsSchema, v.null()]),
});
export const statuteVersionsSuccessResponseSchema = v.pipe(
  v.object({
    items: v.pipe(
      v.array(statuteVersionSchema),
      v.maxLength(LIMITS.legislationVersionsPageSizeMax),
    ),
    limit: v.number(),
    nextCursor: nullableBoundedString(readerTextBytes.cursor),
  }),
  // The versions handler performs one amendment query for the page, then
  // partitions those relations among versions. This is a page-wide budget,
  // not a separate 500-relation allowance for every version.
  v.metadata({
    "x-sharedArrayItems": {
      arrayProperty: "items",
      nestedArrayPath: ["amendedBy", "items"],
      maxItems: LEGISLATION_AMENDMENT_PAGE_MAX,
    },
  }),
);

export const statuteReaderSuccessResponseSchema = v.object({
  ...versionFields,
  pendingChanges: v.union([statuteAmendmentPageSchema, v.null()]),
  createdAt: boundedString(32),
  updatedAt: boundedString(32),
  citationCaseCount: v.union([v.number(), v.null()]),
  allowsDerivedAi: v.boolean(),
  sections: v.union([
    v.array(
      v.object({
        index: v.number(),
        type: v.picklist(DECISION_SECTION_TYPES),
        title: nullableBoundedString(readerTextBytes.sectionTitle),
        text: v.string(),
      }),
    ),
    v.null(),
  ]),
  // The reader deliberately returns the complete official document AST/text.
  // The wire carries it opaque; reading it back yields the parsed AST.
  documentAst: v.pipe(
    v.unknown(),
    v.transform((value) =>
      v.parse(v.nullable(v.union([documentAstSchema, emptyAstSchema])), value),
    ),
  ),
  fulltext: v.union([v.string(), v.null()]),
});

const provisionHistoryItemSchema = v.object({
  country: boundedString(readerTextBytes.country),
  slug: nullableBoundedString(readerTextBytes.slug),
  sourceUrl: nullableBoundedString(readerTextBytes.sourceUrl),
  documentId: resourceIdSchema("legislationDocument"),
  allowsDerivedAi: v.boolean(),
  ...windowFields,
  text: boundedString(readerTextBytes.provisionText),
});
export const provisionHistorySuccessResponseSchema = v.object({
  items: v.pipe(
    v.array(provisionHistoryItemSchema),
    v.maxLength(LIMITS.legislationProvisionHistoryPageSizeMax),
  ),
  limit: v.number(),
  nextCursor: nullableBoundedString(readerTextBytes.cursor),
});
const headingFields = {
  anchorId: boundedString(readerTextBytes.anchor),
  level: v.picklist([1, 2, 3, 4, 5, 6]),
  text: boundedString(readerTextBytes.heading),
};
const provisionPreviewResponseEntries = {
  url: nullableBoundedString(readerTextBytes.documentUrl),
  country: boundedString(readerTextBytes.country),
  documentId: resourceIdSchema("legislationDocument"),
  language: boundedString(readerTextBytes.language),
  anchorId: boundedString(readerTextBytes.anchor),
  citedAnchorId: nullableBoundedString(readerTextBytes.anchor),
  headings: v.pipe(
    v.array(v.object(headingFields)),
    v.maxLength(PREVIEW_HEADING_MAX),
  ),
  heading: v.union([
    v.object({ id: boundedString(readerTextBytes.blockId), ...headingFields }),
    v.null(),
  ]),
  blocks: v.pipe(
    v.array(
      v.object({
        id: boundedString(readerTextBytes.blockId),
        anchorId: boundedString(readerTextBytes.anchor),
        text: boundedString(readerTextBytes.previewText),
      }),
    ),
    v.maxLength(PREVIEW_BLOCK_MAX),
  ),
} satisfies Record<
  keyof typeof provisionPreviewOutput.entries,
  v.GenericSchema
>;
export const provisionPreviewSuccessResponseSchema = v.object(
  provisionPreviewResponseEntries,
);

type Version = v.InferOutput<typeof statuteVersionSchema>;
type VersionRow = Omit<Version, "amendedBy" | "changes"> & {
  amendedBy?: StatuteAmendmentPage | null;
  changes?: StatuteChangeCounts | null;
};
export const projectStatuteVersion = (row: VersionRow): Version => ({
  amendedBy: row.amendedBy ?? null,
  changes: row.changes ?? null,
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

type Reader = v.InferOutput<typeof statuteReaderSuccessResponseSchema>;
type ReaderRow = Omit<Reader, "createdAt" | "updatedAt" | "pendingChanges"> & {
  pendingChanges?: StatuteAmendmentPage | null;
  createdAt: Date;
  updatedAt: Date;
};
export const projectStatuteReader = (row: ReaderRow): Reader => {
  const {
    isDefault: _isDefault,
    amendedBy: _amendedBy,
    changes: _changes,
    ...metadata
  } = projectStatuteVersion({
    ...row,
    isDefault: false,
  });
  return {
    ...metadata,
    pendingChanges: row.pendingChanges ?? null,
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

type HistoryItem = v.InferOutput<typeof provisionHistoryItemSchema>;
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

type PreviewTransport = v.InferOutput<
  typeof provisionPreviewSuccessResponseSchema
>;
type PreviewProjectionInput = ProvisionPreview &
  Omit<PreviewTransport, keyof ProvisionPreview>;

export const projectProvisionPreview = (preview: PreviewProjectionInput) =>
  ({
    url: nullableText(preview.url, readerTextBytes.documentUrl),
    country: truncateTextBytes(preview.country, readerTextBytes.country),
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
  }) satisfies PreviewTransport & v.InferInput<typeof provisionPreviewOutput>;
