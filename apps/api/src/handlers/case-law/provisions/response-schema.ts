import type { TSchema } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { t } from "elysia";

import { PROVISION_LINK_STATUS_TYPES } from "@stll/api-contract/provision-link-status";

import { caseLawProvisionCitations } from "@/api/db/schema";
import { languageAlternatesSchema } from "@/api/handlers/case-law/decisions/search-schema";
import { PROVISION_COUNT_LIMIT } from "@/api/handlers/case-law/provisions/citation-counts";
import type { listCitingDecisionsHandler } from "@/api/handlers/case-law/provisions/citing-decisions";
import type { listDecisionProvisionsHandler } from "@/api/handlers/case-law/provisions/list-for-decision";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import {
  boundedString,
  nullableBoundedString,
} from "@/api/lib/search/response-text-bounds";

const nullableNumber = t.Union([t.Number(), t.Null()]);
const date = nullableBoundedString(128);
const shortText = nullableBoundedString(1024);
const cursor = nullableBoundedString(4096);
export const PROVISION_PREVIEW_BLOCKS_MAX = 32;
export const PROVISION_PREVIEW_HEADINGS_MAX = 32;
export const PROVISION_PREVIEW_TEXT_BYTES = 4096;

type ProvisionItem = Extract<
  Awaited<ReturnType<typeof listDecisionProvisionsHandler>>,
  { items: unknown[] }
>["items"][number];

const citationFields = {
  jurisdiction: boundedString(12),
  workIdentifier: boundedString(1024),
  workNumber: t.Number(),
  workYear: t.Number(),
  workCollection: boundedString(1024),
  workEli: nullableBoundedString(2048),
  workSource: t.Union([
    t.UnionEnum(caseLawProvisionCitations.workSource.enumValues),
    t.Null(),
  ]),
  unit: t.UnionEnum(caseLawProvisionCitations.unit.enumValues),
  section: t.Number(),
  sectionSuffix: shortText,
  subsection: shortText,
  letter: shortText,
  point: shortText,
  sentence: shortText,
  openEnded: t.Boolean(),
  anchor: boundedString(1024),
  versionValidFrom: date,
  sentenceText: boundedString(16_384),
  spanStart: t.Number(),
  spanEnd: t.Number(),
  confidence: t.Number(),
  spanRole: t.Union([
    t.UnionEnum(caseLawProvisionCitations.spanRole.enumValues),
    t.Null(),
  ]),
  printPieceId: nullableBoundedString(256),
  printStart: nullableNumber,
  printEnd: nullableNumber,
  printText: nullableBoundedString(512),
  namePieceId: nullableBoundedString(256),
  nameStart: nullableNumber,
  nameEnd: nullableNumber,
  nameText: shortText,
  selection: t.Union([
    t.UnionEnum(caseLawProvisionCitations.selection.enumValues),
    t.Null(),
  ]),
  printedWorkIdentifier: shortText,
  targetDocumentId: nullableBoundedString(36),
  targetStatus: t.Union([
    t.UnionEnum(caseLawProvisionCitations.targetStatus.enumValues),
    t.Null(),
  ]),
  previewKey: nullableBoundedString(1061),
} as const satisfies Record<keyof ProvisionItem | "previewKey", TSchema>;

const previewHeading = {
  anchorId: boundedString(1024),
  // HeadingLevel; a wider data type fails the handler's schema check.
  level: t.Union([
    t.Literal(1),
    t.Literal(2),
    t.Literal(3),
    t.Literal(4),
    t.Literal(5),
    t.Literal(6),
  ]),
  text: boundedString(PROVISION_PREVIEW_TEXT_BYTES),
};
const provisionPreviewSchema = t.Object({
  key: boundedString(1061),
  documentId: tSafeId("legislationDocument"),
  language: boundedString(32),
  anchorId: boundedString(1024),
  citedAnchorId: shortText,
  headings: t.Array(t.Object(previewHeading), {
    maxItems: PROVISION_PREVIEW_HEADINGS_MAX,
  }),
  heading: t.Union([
    t.Object({ ...previewHeading, id: boundedString(1024) }),
    t.Null(),
  ]),
  blocks: t.Array(
    t.Object({
      id: boundedString(1024),
      anchorId: boundedString(1024),
      text: boundedString(PROVISION_PREVIEW_TEXT_BYTES),
    }),
    { maxItems: PROVISION_PREVIEW_BLOCKS_MAX },
  ),
  truncated: t.Boolean(),
});

export const decisionProvisionsSuccessResponseSchema = t.Object({
  items: t.Array(t.Object(citationFields), {
    maxItems: LIMITS.caseLawSearchPageSizeMax,
  }),
  limit: t.Number(),
  nextCursor: cursor,
  status: t.Object({ type: t.UnionEnum(PROVISION_LINK_STATUS_TYPES) }),
  generation: boundedString(128),
  publishedProjectionDigest: nullableBoundedString(128),
  previews: t.Array(provisionPreviewSchema, {
    maxItems: LIMITS.caseLawSearchPageSizeMax,
  }),
});

export const citingDecisionsSuccessResponseSchema = t.Object({
  items: t.Array(
    t.Object({
      decisionId: boundedString(36),
      caseNumber: boundedString(1024),
      slug: nullableBoundedString(1024),
      court: boundedString(2048),
      country: boundedString(12),
      language: boundedString(32),
      decisionDate: date,
      citationAuthority: nullableNumber,
      sentenceText: nullableBoundedString(16_384),
      spanStart: t.Number(),
      spanEnd: t.Number(),
      languageAlternates: languageAlternatesSchema,
    } satisfies Record<
      keyof Extract<
        Awaited<ReturnType<typeof listCitingDecisionsHandler>>,
        { items: unknown[] }
      >["items"][number],
      TSchema
    >),
    { maxItems: LIMITS.caseLawSearchPageSizeMax },
  ),
  limit: t.Number(),
  nextCursor: cursor,
});

export const citationCountsSuccessResponseSchema = t.Union([
  t.Object({ status: t.Literal("building") }),
  t.Object({ status: t.Literal("unavailable") }),
  t.Object({
    status: t.Literal("ready"),
    provisions: t.Array(
      t.Object({ anchor: boundedString(1024), decisionCount: Type.Integer() }),
      { maxItems: PROVISION_COUNT_LIMIT },
    ),
  }),
]);
