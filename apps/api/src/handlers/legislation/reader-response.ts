import { panic } from "better-result";
import * as v from "valibot";

import {
  LEGISLATION_EXPRESSION_KINDS,
  LEGISLATION_WINDOW_DISPOSITION_BASIS_VALUES,
  LEGISLATION_WINDOW_DISPOSITIONS,
} from "@stll/api-contract/legislation-expression";
import { statuteChangeCountsSchema } from "@stll/api-contract/statute-version-changes";
import { documentAstSchema } from "@stll/legal-ast/document-ast";
import { GOVERNING_WORDING_POSITIONS } from "@stll/legal-ast/provision-preview";
import type { StatuteChangeCounts } from "@stll/legal-ast/statute-compare";

import { PROVISION_WORDING_CHANGES } from "@/api/handlers/legislation/provision-wording-change";
import type { provisionPreviewOutput } from "@/api/lib/chat/decision-reader-projections";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import {
  DECISION_SECTION_TYPES,
  emptyAstSchema,
} from "@/api/lib/legal-search/document-types";
import {
  type LegislationAmendmentEffect,
  legislationAmendmentEffectSchema,
} from "@/api/lib/legal-search/legislation-amendment-effect";
import {
  LEGISLATION_AMENDMENT_CHANNEL_LIMIT,
  LEGISLATION_AMENDMENT_CHANNEL_MAX_BYTES,
  LEGISLATION_AMENDMENT_LEGACY_CHANNEL,
} from "@/api/lib/legal-search/legislation-amendment-observations";
import {
  LEGISLATION_AMENDMENT_PAGE_MAX,
  type readLegislationAmendments,
  type readLegislationAmendmentSnapshot,
  storedLegislationAmendmentRelation,
} from "@/api/lib/legal-search/legislation-amendments";
import { LEGISLATION_AMENDMENT_CHANGE_KINDS } from "@/api/lib/legal-search/legislation-ingestion-types";
import type {
  LegislationAmendmentChannelObservation,
  LegislationAmendmentCoverage,
  LegislationAmendmentPositiveEvidence,
  LegislationAmendmentStoredCoverage,
} from "@/api/lib/legal-search/legislation-ingestion-types";
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
const amendmentEffectResponseSchema = v.variant("type", [
  legislationAmendmentEffectSchema.options[0],
  v.object({
    ...legislationAmendmentEffectSchema.options[1].entries,
    text: nullableBoundedString(8192),
  }),
  legislationAmendmentEffectSchema.options[2],
]);
const amendmentRelationResponseSchema = v.object({
  publisherId: boundedString(8192),
  amendingEli: boundedString(readerTextBytes.eli),
  amendingTitle: nullableBoundedString(readerTextBytes.title),
  amendingAnchor: nullableBoundedString(8192),
  affectedAnchor: boundedString(8192),
  changeKind: v.picklist(LEGISLATION_AMENDMENT_CHANGE_KINDS),
  effective: amendmentEffectResponseSchema,
  publisherInstruction: nullableBoundedString(8192),
});
const observationFields = {
  channel: boundedString(LEGISLATION_AMENDMENT_CHANNEL_MAX_BYTES),
  observedAt: boundedString(32),
};
const positiveEvidenceFields = {
  observedAt: observationFields.observedAt,
  relation: amendmentRelationResponseSchema,
  retainedConditional: v.optional(
    v.object({
      observedAt: v.pipe(
        observationFields.observedAt,
        v.description(
          "Time of the latest incorporated conditional contribution; individual fields may originate earlier.",
        ),
      ),
      relation: v.pipe(
        amendmentRelationResponseSchema,
        v.description(
          "Bounded same-channel conditional projection, distinct from the latest raw relation.",
        ),
      ),
    }),
  ),
};
const amendmentObservationsSchema = v.pipe(
  v.array(
    v.variant("status", [
      v.object({
        status: v.picklist(["present", "historical"]),
        ...observationFields,
        ...positiveEvidenceFields,
      }),
      v.object({
        status: v.literal("absent"),
        ...observationFields,
        lastPositive: v.nullable(v.object(positiveEvidenceFields)),
      }),
    ]),
  ),
  v.maxLength(LEGISLATION_AMENDMENT_CHANNEL_LIMIT),
);

const resolvedAmendmentEffectSchema = v.union([
  amendmentEffectResponseSchema,
  v.object({ type: v.literal("conflicting") }),
]);

const amendmentCoverageSchema = v.union([
  v.object({ type: v.literal("complete") }),
  v.object({
    type: v.literal("partial"),
    unlocatedRelations: v.number(),
    reason: boundedString(8192),
  }),
  v.object({ type: v.literal("not-stated"), reason: boundedString(8192) }),
]);
const amendmentCoverageAggregationSchema = v.object({
  representativeChannel: boundedString(LEGISLATION_AMENDMENT_CHANNEL_MAX_BYTES),
  channels: v.pipe(
    v.array(
      v.object({
        channel: boundedString(LEGISLATION_AMENDMENT_CHANNEL_MAX_BYTES),
        coverage: amendmentCoverageSchema,
      }),
    ),
    v.maxLength(LEGISLATION_AMENDMENT_CHANNEL_LIMIT),
  ),
  distinctUnlocatedTotal: v.variant("type", [
    v.object({ type: v.literal("exact"), count: v.number() }),
    v.object({ type: v.literal("unknown") }),
  ]),
});
const statuteAmendmentPageSchema = v.object({
  items: v.pipe(
    v.array(
      v.object({
        publisherId: boundedString(8192),
        /**
         * Other publisher links that state the same instruction (same
         * amending act, provision, change and effective day). The publisher
         * records them separately and they are stored as published; a read
         * shows the instruction once and names every link.
         */
        duplicatePublisherIds: v.pipe(
          v.array(boundedString(8192)),
          v.maxLength(LEGISLATION_AMENDMENT_PAGE_MAX),
        ),
        amendingEli: boundedString(readerTextBytes.eli),
        amendingTitle: nullableBoundedString(readerTextBytes.title),
        affectedAnchor: boundedString(8192),
        changeKind: v.picklist(LEGISLATION_AMENDMENT_CHANGE_KINDS),
        effectiveDate: nullableBoundedString(32),
        effectiveText: nullableBoundedString(8192),
        effective: resolvedAmendmentEffectSchema,
        observations: amendmentObservationsSchema,
      }),
    ),
    v.maxLength(LEGISLATION_AMENDMENT_PAGE_MAX),
  ),
  observedAt: boundedString(32),
  coverage: v.union([
    v.object({
      ...amendmentCoverageSchema.options[0].entries,
      aggregation: v.optional(amendmentCoverageAggregationSchema),
    }),
    v.object({
      ...amendmentCoverageSchema.options[1].entries,
      aggregation: v.optional(amendmentCoverageAggregationSchema),
    }),
    v.object({
      ...amendmentCoverageSchema.options[2].entries,
      aggregation: v.optional(amendmentCoverageAggregationSchema),
    }),
  ]),
  truncated: v.boolean(),
});

export type StatuteAmendmentPage = v.InferOutput<
  typeof statuteAmendmentPageSchema
>;

// Field by field: a stored snapshot written before its keys were closed must
// still pass the closed response schema.
const projectedCoverageReport = (
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

const projectedCoverage = (
  coverage: LegislationAmendmentStoredCoverage,
): StatuteAmendmentPage["coverage"] => {
  const report = projectedCoverageReport(coverage);
  if (coverage.aggregation === undefined) {
    return report;
  }
  return {
    ...report,
    aggregation: {
      representativeChannel: coverage.aggregation.representativeChannel,
      channels: coverage.aggregation.channels.map(
        ({ channel, coverage: item }) => ({
          channel,
          coverage: projectedCoverageReport(item),
        }),
      ),
      distinctUnlocatedTotal: coverage.aggregation.distinctUnlocatedTotal,
    },
  };
};

type AmendmentRow = Awaited<
  ReturnType<typeof readLegislationAmendments>
>["items"][number];

/**
 * One entry per instruction: links that name the same amending act,
 * provision, change and effective day (or the same stated effective text)
 * are the publisher restating one instruction. The first link in page order
 * leads; the others travel as its duplicates, so no link id is dropped. The
 * change kind is part of the key: two kinds on one day are two instructions.
 */
const amendmentPositiveDedupeKey = (
  item: LegislationAmendmentPositiveEvidence,
) => ({
  observedAt: item.observedAt,
  relation: { ...item.relation, publisherId: "" },
  ...(item.retainedConditional === undefined
    ? {}
    : {
        retainedConditional: {
          ...item.retainedConditional,
          relation: { ...item.retainedConditional.relation, publisherId: "" },
        },
      }),
});
const amendmentObservationDedupeKey = (
  item: LegislationAmendmentChannelObservation,
) => {
  if (item.status !== "absent") {
    return {
      status: item.status,
      channel: item.channel,
      ...amendmentPositiveDedupeKey(item),
    };
  }
  return {
    ...item,
    lastPositive:
      item.lastPositive === null
        ? null
        : amendmentPositiveDedupeKey(item.lastPositive),
  };
};

const dedupeAmendments = (
  rows: readonly AmendmentRow[],
): { row: AmendmentRow; duplicates: AmendmentRow[] }[] => {
  const groups = new Map<
    string,
    { row: AmendmentRow; duplicates: AmendmentRow[] }
  >();
  for (const row of rows) {
    const key = JSON.stringify([
      row.amendingEli,
      row.affectedAnchor,
      row.changeKind,
      row.effectiveDate,
      row.effectiveDate === null ? row.effectiveText : null,
      row.effectDetails,
      row.observations?.map(amendmentObservationDedupeKey),
    ]);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { row, duplicates: [] });
    } else {
      group.duplicates.push(row);
    }
  }
  return [...groups.values()];
};

const projectAmendmentEffect = (
  effect: LegislationAmendmentEffect,
): LegislationAmendmentEffect => {
  switch (effect.type) {
    case "date":
      return { type: "date", on: effect.on };
    case "not-stated":
      return { type: "not-stated", text: nullableText(effect.text, 8192) };
    case "conditional":
      return {
        type: "conditional",
        condition: {
          text: truncateTextBytes(effect.condition.text, 8192),
          label: nullableText(effect.condition.label, 8192),
        },
        workingDate: effect.workingDate,
        actualDate: effect.actualDate,
      };
    default:
      effect satisfies never;
      return panic("Unhandled amendment effect");
  }
};

const projectAmendmentRelation = (
  relation: ReturnType<typeof storedLegislationAmendmentRelation>,
) => ({
  publisherId: truncateTextBytes(relation.publisherId, 8192),
  amendingEli: truncateTextBytes(relation.amendingEli, readerTextBytes.eli),
  amendingTitle: nullableText(relation.amendingTitle, readerTextBytes.title),
  amendingAnchor: nullableText(relation.amendingAnchor, 8192),
  affectedAnchor: truncateTextBytes(relation.affectedAnchor, 8192),
  changeKind: relation.changeKind,
  effective: projectAmendmentEffect(relation.effective),
  publisherInstruction: nullableText(relation.publisherInstruction, 8192),
});

const projectAmendmentPositiveEvidence = (
  item: LegislationAmendmentPositiveEvidence,
) => ({
  observedAt: item.observedAt,
  relation: projectAmendmentRelation(item.relation),
  ...(item.retainedConditional === undefined
    ? {}
    : {
        retainedConditional: {
          observedAt: item.retainedConditional.observedAt,
          relation: projectAmendmentRelation(item.retainedConditional.relation),
        },
      }),
});

const projectAmendmentObservation = (
  item: LegislationAmendmentChannelObservation,
) => {
  switch (item.status) {
    case "present":
      return {
        status: "present",
        channel: item.channel,
        ...projectAmendmentPositiveEvidence(item),
      } as const;
    case "historical":
      return {
        status: "historical",
        channel: item.channel,
        ...projectAmendmentPositiveEvidence(item),
      } as const;
    case "absent":
      return {
        status: "absent",
        channel: item.channel,
        observedAt: item.observedAt,
        lastPositive:
          item.lastPositive === null
            ? null
            : projectAmendmentPositiveEvidence(item.lastPositive),
      } as const;
    default:
      item satisfies never;
      return panic("Unhandled amendment observation state");
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
    items: dedupeAmendments(page.items).map(({ row, duplicates }) => ({
      publisherId: truncateTextBytes(row.publisherId, 8192),
      duplicatePublisherIds: duplicates.map((duplicate) =>
        truncateTextBytes(duplicate.publisherId, 8192),
      ),
      amendingEli: truncateTextBytes(row.amendingEli, readerTextBytes.eli),
      amendingTitle: nullableText(row.amendingTitle, readerTextBytes.title),
      affectedAnchor: truncateTextBytes(row.affectedAnchor, 8192),
      changeKind: row.changeKind,
      effectiveDate: row.effectiveDate,
      effectiveText: nullableText(row.effectiveText, 8192),
      effective:
        row.effectDetails?.type === "conflicting"
          ? { type: "conflicting" }
          : projectAmendmentEffect(
              row.effectDetails ??
                storedLegislationAmendmentRelation(row).effective,
            ),
      observations: (
        row.observations ?? [
          {
            status: "present",
            channel: LEGISLATION_AMENDMENT_LEGACY_CHANNEL,
            observedAt: snapshot.observedAt.toISOString(),
            relation: storedLegislationAmendmentRelation(row),
          } satisfies LegislationAmendmentChannelObservation,
        ]
      ).map(projectAmendmentObservation),
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

const provisionHistoryVersionFields = {
  country: boundedString(readerTextBytes.country),
  slug: nullableBoundedString(readerTextBytes.slug),
  sourceUrl: nullableBoundedString(readerTextBytes.sourceUrl),
  documentId: resourceIdSchema("legislationDocument"),
  allowsDerivedAi: v.boolean(),
  ...windowFields,
};
const foundProvisionHistoryItemSchema = v.object({
  ...provisionHistoryVersionFields,
  status: v.literal("found"),
  /**
   * How this wording relates to the consolidation just before it, compared
   * on the full text; see `PROVISION_WORDING_CHANGES`.
   */
  wordingChange: v.picklist(PROVISION_WORDING_CHANGES),
  text: boundedString(readerTextBytes.provisionText),
  /**
   * Wording outside the read subdivision that governs it; see
   * `governingWording` in `@stll/legal-ast/provision-preview`.
   */
  governingText: v.pipe(
    v.array(
      v.object({
        anchor: boundedString(readerTextBytes.anchor),
        position: v.picklist(GOVERNING_WORDING_POSITIONS),
        text: boundedString(readerTextBytes.provisionText),
      }),
    ),
    v.maxLength(LIMITS.legislationGoverningTextMax),
  ),
  /** Present when governing wording past the bound was left out. */
  governingTextTruncated: v.optional(v.literal(true)),
});
/** A consolidation whose structure could not be read: no wording, no claim. */
const unavailableProvisionHistoryItemSchema = v.object({
  ...provisionHistoryVersionFields,
  status: v.literal("unavailable"),
});
const provisionHistoryItemSchema = v.variant("status", [
  foundProvisionHistoryItemSchema,
  unavailableProvisionHistoryItemSchema,
]);
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
type FoundHistoryItem = v.InferOutput<typeof foundProvisionHistoryItemSchema>;
export const projectProvisionHistoryItem = (row: HistoryItem): HistoryItem =>
  row.status === "found"
    ? projectFoundProvisionHistoryItem(row)
    : { ...projectHistoryVersion(row), status: row.status };

const projectHistoryVersion = (row: HistoryItem) => ({
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
});

const projectFoundProvisionHistoryItem = (
  row: FoundHistoryItem,
): FoundHistoryItem => ({
  ...projectHistoryVersion(row),
  status: row.status,
  wordingChange: row.wordingChange,
  text: truncateTextBytes(row.text, readerTextBytes.provisionText),
  ...(row.governingTextTruncated === true ||
  row.governingText.length > LIMITS.legislationGoverningTextMax
    ? { governingTextTruncated: true as const }
    : {}),
  governingText: row.governingText
    .slice(0, LIMITS.legislationGoverningTextMax)
    .map((wording) => ({
      anchor: truncateTextBytes(wording.anchor, readerTextBytes.anchor),
      position: wording.position,
      text: truncateTextBytes(wording.text, readerTextBytes.provisionText),
    })),
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
