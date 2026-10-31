import * as v from "valibot";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import { STATED_DATE_RELATIONS } from "@stll/api-contract/provision-applied-version";
import { PROVISION_CITING_SNAPSHOT_LIMIT } from "@stll/api-contract/provision-citing-decisions";
import type { ProvisionLinkCapability } from "@stll/api-contract/provision-link-capability";
import { PROVISION_LINK_STATUS_TYPES } from "@stll/api-contract/provision-link-status";

import { caseLawProvisionCitations } from "@/api/db/schema";
import { languageAlternatesSchema } from "@/api/handlers/case-law/decisions/search-schema";
import { PROVISION_COUNT_LIMIT } from "@/api/handlers/case-law/provisions/citation-counts";
import type { listCitingDecisionsHandler } from "@/api/handlers/case-law/provisions/citing-decisions";
import type { listDecisionProvisionsHandler } from "@/api/handlers/case-law/provisions/list-for-decision";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import {
  boundedString,
  nullableBoundedString,
} from "@/api/lib/search/response-text-bounds";

const evidenceFields = { start: v.number(), end: v.number() };
const expression = v.union([
  v.object({ date: boundedString(128), eli: boundedString(2048) }),
  v.null(),
]);
const versionBasisSchema = v.union([
  v.object({ type: v.literal("inferred"), kind: v.literal("decision_date") }),
  v.object({ type: v.literal("not_stated") }),
  v.object({
    type: v.literal("stated_date"),
    date: boundedString(128),
    relation: v.picklist(STATED_DATE_RELATIONS),
    expression,
    evidence: v.object({ ...evidenceFields, kind: v.literal("stated_date") }),
  }),
  v.object({
    type: v.literal("stated_version"),
    amendmentWorkIdentifier: boundedString(1024),
    expression,
    evidence: v.object({
      ...evidenceFields,
      kind: v.literal("stated_version"),
    }),
  }),
]);
const inferredVersionCandidateSchema = v.object({
  type: v.literal("inferred"),
  kind: v.literal("decision_date"),
  versionValidFrom: nullableBoundedString(128),
});

const nullableNumber = v.union([v.number(), v.null()]);
const date = nullableBoundedString(128);
const shortText = nullableBoundedString(1024);
const cursor = nullableBoundedString(4096);
export const PROVISION_PREVIEW_BLOCKS_MAX = 32;
export const PROVISION_PREVIEW_HEADINGS_MAX = 32;
const PROVISION_PREVIEW_TEXT_BYTES = 4096;

type ProvisionItem = Extract<
  Awaited<ReturnType<typeof listDecisionProvisionsHandler>>,
  { items: unknown[] }
>["items"][number];

const citationFields = {
  jurisdiction: boundedString(12),
  workIdentifier: boundedString(1024),
  workNumber: nullableNumber,
  workYear: nullableNumber,
  workCollection: boundedString(1024),
  workEli: nullableBoundedString(2048),
  workSource: v.union([
    v.picklist(caseLawProvisionCitations.workSource.enumValues),
    v.null(),
  ]),
  unit: v.picklist(caseLawProvisionCitations.unit.enumValues),
  section: v.number(),
  sectionSuffix: shortText,
  subsection: shortText,
  letter: shortText,
  point: shortText,
  sentence: shortText,
  openEnded: v.boolean(),
  anchor: boundedString(1024),
  versionValidFrom: date,
  versionBasis: versionBasisSchema,
  inferredVersionCandidate: inferredVersionCandidateSchema,
  sentenceText: boundedString(16_384),
  spanStart: v.number(),
  spanEnd: v.number(),
  confidence: v.number(),
  spanRole: v.union([
    v.picklist(caseLawProvisionCitations.spanRole.enumValues),
    v.null(),
  ]),
  printPieceId: nullableBoundedString(256),
  printStart: nullableNumber,
  printEnd: nullableNumber,
  printText: nullableBoundedString(512),
  namePieceId: nullableBoundedString(256),
  nameStart: nullableNumber,
  nameEnd: nullableNumber,
  nameText: shortText,
  selection: v.union([
    v.picklist(caseLawProvisionCitations.selection.enumValues),
    v.null(),
  ]),
  printedWorkIdentifier: shortText,
  targetDocumentId: v.union([
    resourceIdSchema("legislationDocument"),
    v.null(),
  ]),
  targetStatus: v.union([
    v.picklist(caseLawProvisionCitations.targetStatus.enumValues),
    v.null(),
  ]),
  previewKey: nullableBoundedString(1061),
} as const satisfies Record<
  keyof ProvisionItem | "previewKey",
  v.GenericSchema
>;

const previewHeading = {
  anchorId: boundedString(1024),
  // HeadingLevel; a wider data type fails the handler's schema check.
  level: v.union([
    v.literal(1),
    v.literal(2),
    v.literal(3),
    v.literal(4),
    v.literal(5),
    v.literal(6),
  ]),
  text: boundedString(PROVISION_PREVIEW_TEXT_BYTES),
};
const provisionPreviewSchema = v.object({
  key: boundedString(1061),
  documentId: resourceIdSchema("legislationDocument"),
  language: boundedString(32),
  anchorId: boundedString(1024),
  citedAnchorId: shortText,
  headings: v.pipe(
    v.array(v.object(previewHeading)),
    v.maxLength(PROVISION_PREVIEW_HEADINGS_MAX),
  ),
  heading: v.union([
    v.object({ ...previewHeading, id: boundedString(1024) }),
    v.null(),
  ]),
  blocks: v.pipe(
    v.array(
      v.object({
        id: boundedString(1024),
        anchorId: boundedString(1024),
        text: boundedString(PROVISION_PREVIEW_TEXT_BYTES),
      }),
    ),
    v.maxLength(PROVISION_PREVIEW_BLOCKS_MAX),
  ),
  truncated: v.boolean(),
});

type ProvisionCapabilitySchemas = {
  readonly [Kind in ProvisionLinkCapability["type"]]: v.GenericSchema<
    Extract<ProvisionLinkCapability, { type: Kind }>
  >;
};

const provisionCapabilitySchemas = {
  supported: v.object({
    type: v.literal("supported"),
    languages: v.pipe(
      v.array(boundedString(32)),
      v.minLength(1),
      v.maxLength(64),
    ),
  }),
  notSupportedYet: v.object({
    type: v.literal("notSupportedYet"),
    reason: v.picklist([
      "no_profile",
      "no_multilingual_profile",
      "language_not_supported",
      "unknown_jurisdiction",
    ]),
  }),
} as const satisfies ProvisionCapabilitySchemas;

const provisionCapabilitySchema = v.union([
  provisionCapabilitySchemas.supported,
  provisionCapabilitySchemas.notSupportedYet,
]);

export const decisionProvisionsSuccessResponseSchema = v.object({
  items: v.pipe(
    v.array(v.object(citationFields)),
    v.maxLength(LIMITS.caseLawSearchPageSizeMax),
  ),
  limit: v.number(),
  nextCursor: cursor,
  status: v.object({ type: v.picklist(PROVISION_LINK_STATUS_TYPES) }),
  capability: provisionCapabilitySchema,
  pendingSince: nullableBoundedString(128),
  generation: boundedString(128),
  publishedProjectionDigest: nullableBoundedString(128),
  previews: v.pipe(
    v.array(provisionPreviewSchema),
    v.maxLength(LIMITS.caseLawSearchPageSizeMax),
  ),
});

export const citingDecisionsSuccessResponseSchema = v.object({
  items: v.pipe(
    v.array(
      v.object({
        decisionId: resourceIdSchema("caseLawDecision"),
        caseNumber: boundedString(1024),
        slug: nullableBoundedString(1024),
        court: boundedString(2048),
        courtAbbreviation: nullableBoundedString(2048),
        courtTier: v.picklist(COURT_TIER_LABELS),
        mentionCount: v.pipe(v.number(), v.integer(), v.minValue(1)),
        snippetCitation: v.union([
          v.object({
            start: v.pipe(v.number(), v.integer(), v.minValue(0)),
            end: v.pipe(v.number(), v.integer(), v.minValue(1)),
          }),
          v.null(),
        ]),
        sourceUrl: nullableBoundedString(8192),
        country: boundedString(12),
        language: boundedString(32),
        decisionDate: date,
        versionBasis: versionBasisSchema,
        versionValidFrom: date,
        inferredVersionCandidate: inferredVersionCandidateSchema,
        citationAuthority: v.number(),
        sentenceText: nullableBoundedString(16_384),
        spanStart: v.number(),
        spanEnd: v.number(),
        languageAlternates: languageAlternatesSchema,
      } satisfies Record<
        keyof Extract<
          Awaited<ReturnType<typeof listCitingDecisionsHandler>>,
          { items: unknown[] }
        >["items"][number],
        v.GenericSchema
      >),
    ),
    v.maxLength(
      Math.max(
        LIMITS.caseLawSearchPageSizeMax,
        PROVISION_CITING_SNAPSHOT_LIMIT,
      ),
    ),
  ),
  limit: v.number(),
  nextCursor: cursor,
  snapshot: v.union([
    v.object({
      type: v.picklist(["complete", "capped"]),
      limit: v.literal(PROVISION_CITING_SNAPSHOT_LIMIT),
    }),
    v.null(),
  ]),
});

export const citationCountsSuccessResponseSchema = v.union([
  v.object({ status: v.literal("building") }),
  v.object({ status: v.literal("unavailable") }),
  v.object({
    status: v.literal("ready"),
    provisions: v.pipe(
      v.array(
        v.object({
          anchor: boundedString(1024),
          decisionCount: v.pipe(v.number(), v.integer()),
        }),
      ),
      v.maxLength(PROVISION_COUNT_LIMIT),
    ),
  }),
]);
