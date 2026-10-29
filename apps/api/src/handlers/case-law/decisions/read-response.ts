import { panic } from "better-result";
import * as v from "valibot";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import { DECISION_READ_RESOLUTION } from "@stll/api-contract/case-law-decision-resolution";
import { caseLawTextStatusSchema } from "@stll/api-contract/case-law-fulltext-state";
import { DECISION_JUDGE_ROLES } from "@stll/api-contract/case-law-judges";
import {
  TEXT_ABSENCE_REASONS,
  TEXT_FIELD_TYPE,
  type TextField,
} from "@stll/api-contract/case-law-text-field";
import {
  DECISION_IDENTIFIER_MAX_COUNT,
  DECISION_IDENTIFIER_MAX_LENGTH,
  DECISION_IDENTIFIER_TYPES,
  DECISION_PRIMARY_REFERENCE_TYPES,
} from "@stll/legal-ast/decision-identifier";

import type { readDecisionHandler } from "@/api/handlers/case-law/decisions/get";
import { safePublicHandlerResponseSchemasWithStatusText } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { DECISION_SECTION_TYPES } from "@/api/lib/legal-search/document-types";
import { LIMITS } from "@/api/lib/limits";
import { responseByteBound } from "@/api/lib/search/response-byte-bound";
import {
  boundedString,
  nullableBoundedString,
  nullableText,
  truncateTextBytes,
} from "@/api/lib/search/response-text-bounds";
import { isRecord } from "@/api/lib/type-guards";

type ReadableDecision = Extract<
  Awaited<ReturnType<typeof readDecisionHandler>>,
  { documentPending: boolean }
>;

// Varchar bounds reserve four UTF-8 bytes per stored Unicode character.
// Unbounded publisher prose receives a display budget; storage stays whole.
const DECISION_READER_TEXT_BYTES = {
  caseNumber: 256 * 4,
  slug: 256 * 4,
  ecli: 256 * 4,
  court: 512 * 4,
  courtId: 128 * 4,
  courtAbbreviation: 512 * 4,
  country: 3 * 4,
  language: 8 * 4,
  languageGroupKey: 512 * 4,
  decisionDate: 32,
  decisionType: 128 * 4,
  projectionDigest: 128,
  sourceUrl: 8192,
  sourceAttributionUrl: 8192,
  documentUrl: 8192,
} as const satisfies Record<
  Exclude<
    {
      [Key in keyof ReadableDecision]: ReadableDecision[Key] extends
        string | null
        ? Key
        : never;
    }[keyof ReadableDecision],
    | "id"
    | "caseNumberType"
    | "fulltext"
    | "citationsNextCursor"
    | "courtTier"
    | "documentAstSource"
    | "textState"
  >,
  number
>;

const PROSE_BYTES = 65_536;
const LABEL_BYTES = 2048;
const URL_BYTES = 8192;
const CURSOR_BYTES = 2048;
const METADATA_KEY_BYTES = 512;
const METADATA_DEPTH = 4;
const METADATA_NODES = 32;
const JUDGES_MAX = 128;

const metadataScalarSchema = v.union([
  boundedString(PROSE_BYTES),
  v.number(),
  v.boolean(),
  v.null(),
]);

const metadataValueSchema = (depth: number): v.GenericSchema => {
  if (depth === 0) {
    return metadataScalarSchema;
  }
  const child = metadataValueSchema(depth - 1);
  return v.union([
    metadataScalarSchema,
    v.pipe(v.array(child), v.maxLength(METADATA_NODES)),
    v.pipe(
      v.record(boundedString(METADATA_KEY_BYTES), child),
      v.maxEntries(METADATA_NODES),
    ),
  ]);
};

// The stored metadata contract is open; this finite wire schema bounds every
// nested value without exposing recursive references to the response guard.
const metadataSchema = v.pipe(
  v.record(
    boundedString(METADATA_KEY_BYTES),
    metadataValueSchema(METADATA_DEPTH),
  ),
  v.maxEntries(METADATA_NODES),
);

const textFieldSchema = v.union([
  v.object({
    type: v.literal(TEXT_FIELD_TYPE.PRESENT),
    text: boundedString(PROSE_BYTES),
  }),
  v.object({
    type: v.literal(TEXT_FIELD_TYPE.ABSENT),
    reason: v.picklist([...TEXT_ABSENCE_REASONS]),
  }),
]);

const languageAlternateSchema = v.object({
  id: boundedString(36),
  caseNumber: boundedString(DECISION_READER_TEXT_BYTES.caseNumber),
  country: boundedString(DECISION_READER_TEXT_BYTES.country),
  court: boundedString(DECISION_READER_TEXT_BYTES.court),
  decisionDate: nullableBoundedString(DECISION_READER_TEXT_BYTES.decisionDate),
  language: boundedString(DECISION_READER_TEXT_BYTES.language),
  slug: nullableBoundedString(DECISION_READER_TEXT_BYTES.slug),
  hasDocument: v.boolean(),
} satisfies Record<
  keyof ReadableDecision["languageAlternates"][number],
  v.GenericSchema
>);

const caseFileDocumentSchema = v.object({
  textState: v.nullable(caseLawTextStatusSchema),
  id: resourceIdSchema("caseLawDecision"),
  caseNumber: boundedString(DECISION_READER_TEXT_BYTES.caseNumber),
  country: boundedString(DECISION_READER_TEXT_BYTES.country),
  court: boundedString(DECISION_READER_TEXT_BYTES.court),
  decisionDate: nullableBoundedString(DECISION_READER_TEXT_BYTES.decisionDate),
  decisionType: nullableBoundedString(DECISION_READER_TEXT_BYTES.decisionType),
  ecli: nullableBoundedString(DECISION_READER_TEXT_BYTES.ecli),
  language: boundedString(DECISION_READER_TEXT_BYTES.language),
  languageGroupKey: nullableBoundedString(
    DECISION_READER_TEXT_BYTES.languageGroupKey,
  ),
  slug: nullableBoundedString(DECISION_READER_TEXT_BYTES.slug),
  languageAlternates: v.pipe(
    v.array(v.pick(languageAlternateSchema, ["language"])),
    v.maxLength(LIMITS.caseLawLanguageAlternatesPerGroupMax),
  ),
} satisfies Record<
  keyof ReadableDecision["caseFile"]["items"][number],
  v.GenericSchema
>);

export const readDecisionSuccessResponseSchema = v.object({
  textState: v.nullable(caseLawTextStatusSchema),
  documentPending: v.boolean(),
  hasDocument: v.boolean(),
  documentReadFailed: v.boolean(),
  documentUnavailable: v.boolean(),
  id: resourceIdSchema("caseLawDecision"),
  resolution: v.union([
    v.object({ type: v.literal(DECISION_READ_RESOLUTION.DIRECT) }),
    v.object({
      type: v.literal(DECISION_READ_RESOLUTION.ABSORBED_SUPPLEMENT),
      absorbedDecisionId: resourceIdSchema("caseLawDecision"),
      anchorPrefix: boundedString(LABEL_BYTES),
    }),
  ]),
  caseNumber: boundedString(DECISION_READER_TEXT_BYTES.caseNumber),
  caseNumberType: v.picklist([...DECISION_PRIMARY_REFERENCE_TYPES]),
  slug: nullableBoundedString(DECISION_READER_TEXT_BYTES.slug),
  ecli: nullableBoundedString(DECISION_READER_TEXT_BYTES.ecli),
  identifiers: v.pipe(
    v.array(
      v.object({
        type: v.enum(DECISION_IDENTIFIER_TYPES),
        value: boundedString(DECISION_IDENTIFIER_MAX_LENGTH * 4),
      }),
    ),
    v.minLength(1),
    v.maxLength(DECISION_IDENTIFIER_MAX_COUNT),
  ),
  court: boundedString(DECISION_READER_TEXT_BYTES.court),
  courtId: nullableBoundedString(DECISION_READER_TEXT_BYTES.courtId),
  courtAbbreviation: nullableBoundedString(
    DECISION_READER_TEXT_BYTES.courtAbbreviation,
  ),
  courtTier: v.picklist([...COURT_TIER_LABELS]),
  country: boundedString(DECISION_READER_TEXT_BYTES.country),
  language: boundedString(DECISION_READER_TEXT_BYTES.language),
  languageGroupKey: nullableBoundedString(
    DECISION_READER_TEXT_BYTES.languageGroupKey,
  ),
  decisionDate: nullableBoundedString(DECISION_READER_TEXT_BYTES.decisionDate),
  decisionType: nullableBoundedString(DECISION_READER_TEXT_BYTES.decisionType),
  citationCount: v.number(),
  documentAst: v.unknown(),
  fulltext: v.nullable(v.string()),
  projectionDigest: nullableBoundedString(
    DECISION_READER_TEXT_BYTES.projectionDigest,
  ),
  documentAstSource: v.union([v.literal("store"), v.literal("row"), v.null()]),
  sections: v.nullable(
    v.array(
      v.object({
        index: v.number(),
        type: v.picklist([...DECISION_SECTION_TYPES]),
        title: nullableBoundedString(LABEL_BYTES),
        blockIndices: v.array(v.pipe(v.number(), v.integer(), v.minValue(0))),
      }),
    ),
  ),
  sourceUrl: nullableBoundedString(DECISION_READER_TEXT_BYTES.sourceUrl),
  sourceAttributionUrl: nullableBoundedString(
    DECISION_READER_TEXT_BYTES.sourceAttributionUrl,
  ),
  documentUrl: nullableBoundedString(DECISION_READER_TEXT_BYTES.documentUrl),
  metadata: metadataSchema,
  headnote: textFieldSchema,
  textFields: v.object({
    abstract: textFieldSchema,
    headnote: textFieldSchema,
    legalSentence: textFieldSchema,
    summary: textFieldSchema,
  }),
  createdAt: boundedString(32),
  updatedAt: boundedString(32),
  source: v.object({
    id: resourceIdSchema("caseLawSource"),
    name: boundedString(256 * 4),
    adapterKey: boundedString(64 * 4),
    allowsDerivedAi: v.boolean(),
  }),
  judges: v.pipe(
    v.array(
      v.object({
        role: v.picklist([...DECISION_JUDGE_ROLES]),
        name: boundedString(LABEL_BYTES),
        judgeId: v.nullable(resourceIdSchema("caseLawJudge")),
        portrait: v.nullable(
          v.object({
            url: boundedString(URL_BYTES),
            attribution: boundedString(LABEL_BYTES),
          }),
        ),
      }),
    ),
    v.maxLength(JUDGES_MAX),
  ),
  citationsFrom: v.pipe(
    v.array(
      v.object({
        id: resourceIdSchema("caseLawCitation"),
        citationText: boundedString(PROSE_BYTES),
        citedDecisionId: v.nullable(resourceIdSchema("caseLawDecision")),
        sectionIndex: v.nullable(v.number()),
      }),
    ),
    v.maxLength(LIMITS.caseLawDecisionCitationPageSize),
  ),
  citationsTo: v.pipe(
    v.array(
      v.object({
        id: resourceIdSchema("caseLawCitation"),
        citationText: boundedString(PROSE_BYTES),
        citingDecisionId: resourceIdSchema("caseLawDecision"),
        sectionIndex: v.nullable(v.number()),
      }),
    ),
    v.maxLength(LIMITS.caseLawDecisionCitationPageSize),
  ),
  citationsNextCursor: nullableBoundedString(CURSOR_BYTES),
  caseFile: v.object({
    items: v.pipe(
      v.array(caseFileDocumentSchema),
      v.maxLength(LIMITS.caseLawCaseFilePageSize),
    ),
    nextCursor: nullableBoundedString(CURSOR_BYTES),
    limit: v.pipe(v.number(), v.maxValue(LIMITS.caseLawCaseFilePageSize)),
  }),
  languageAlternates: v.pipe(
    v.array(languageAlternateSchema),
    v.maxLength(LIMITS.caseLawLanguageAlternatesPerGroupMax),
  ),
} satisfies Record<keyof ReadableDecision, v.GenericSchema>);

export const readDecisionResponseSchema =
  safePublicHandlerResponseSchemasWithStatusText(
    readDecisionSuccessResponseSchema,
  );

// Whole-document fields have their own intentional ingestion boundary.
export const DECISION_READER_NON_DOCUMENT_MAX_BYTES = responseByteBound(
  v.omit(readDecisionSuccessResponseSchema, [
    "documentAst",
    "fulltext",
    "sections",
  ]),
);

const projectTextField = (field: TextField): TextField => {
  switch (field.type) {
    case TEXT_FIELD_TYPE.PRESENT:
      return {
        type: field.type,
        text: truncateTextBytes(field.text, PROSE_BYTES),
      };
    case TEXT_FIELD_TYPE.ABSENT:
      return field;
    default:
      field satisfies never;
      return panic(`Unhandled reader text field: ${String(field)}`);
  }
};

const projectMetadata = (metadata: Record<string, unknown>) => {
  let remaining = METADATA_NODES;
  const project = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") {
      return truncateTextBytes(value, PROSE_BYTES);
    }
    if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      return value;
    }
    if (depth === 0) {
      return null;
    }
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) {
        if (remaining === 0) {
          break;
        }
        remaining -= 1;
        items.push(project(item, depth - 1));
      }
      return items;
    }
    if (isRecord(value)) {
      const entries: [string, unknown][] = [];
      for (const [key, item] of Object.entries(value)) {
        if (remaining === 0) {
          break;
        }
        remaining -= 1;
        entries.push([
          truncateTextBytes(key, METADATA_KEY_BYTES),
          project(item, depth - 1),
        ]);
      }
      return Object.fromEntries(entries);
    }
    return null;
  };
  // Root is a metadata object, including an empty object after the node budget.
  const entries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (remaining === 0) {
      break;
    }
    remaining -= 1;
    entries.push([
      truncateTextBytes(key, METADATA_KEY_BYTES),
      project(value, METADATA_DEPTH),
    ]);
  }
  return Object.fromEntries(entries);
};

export const projectDecisionReader = (decision: ReadableDecision) => {
  const text = DECISION_READER_TEXT_BYTES;
  const [primaryIdentifier, ...otherIdentifiers] = decision.identifiers;
  const identifier = (value: (typeof decision.identifiers)[number]) => ({
    ...value,
    value: truncateTextBytes(value.value, DECISION_IDENTIFIER_MAX_LENGTH * 4),
  });
  // The wire carries the AST opaque, as the schema declares: clients rebuild
  // the derivable block text with `parseDocumentAst` on arrival.
  const documentAst: unknown = decision.documentAst;
  return {
    ...decision,
    documentAst,
    createdAt: decision.createdAt.toISOString(),
    updatedAt: decision.updatedAt.toISOString(),
    resolution:
      decision.resolution.type === DECISION_READ_RESOLUTION.DIRECT
        ? decision.resolution
        : {
            type: decision.resolution.type,
            absorbedDecisionId: decision.resolution.absorbedDecisionId,
            anchorPrefix: truncateTextBytes(
              decision.resolution.anchorPrefix,
              LABEL_BYTES,
            ),
          },
    caseNumber: truncateTextBytes(decision.caseNumber, text.caseNumber),
    slug: nullableText(decision.slug, text.slug),
    ecli: nullableText(decision.ecli, text.ecli),
    identifiers: [
      identifier(primaryIdentifier),
      ...otherIdentifiers
        .slice(0, DECISION_IDENTIFIER_MAX_COUNT - 1)
        .map(identifier),
    ],
    court: truncateTextBytes(decision.court, text.court),
    courtId: nullableText(decision.courtId, text.courtId),
    courtAbbreviation: nullableText(
      decision.courtAbbreviation,
      text.courtAbbreviation,
    ),
    country: truncateTextBytes(decision.country, text.country),
    language: truncateTextBytes(decision.language, text.language),
    languageGroupKey: nullableText(
      decision.languageGroupKey,
      text.languageGroupKey,
    ),
    decisionDate: nullableText(decision.decisionDate, text.decisionDate),
    decisionType: nullableText(decision.decisionType, text.decisionType),
    citationCount: decision.citationCount,
    projectionDigest: nullableText(
      decision.projectionDigest,
      text.projectionDigest,
    ),
    sections:
      decision.sections?.map((section) => ({
        index: section.index,
        type: section.type,
        title: nullableText(section.title, LABEL_BYTES),
        blockIndices: section.blockIndices,
      })) ?? null,
    sourceUrl: nullableText(decision.sourceUrl, text.sourceUrl),
    sourceAttributionUrl: nullableText(
      decision.sourceAttributionUrl,
      text.sourceAttributionUrl,
    ),
    documentUrl: nullableText(decision.documentUrl, text.documentUrl),
    metadata: projectMetadata(decision.metadata),
    headnote: projectTextField(decision.headnote),
    textFields: {
      abstract: projectTextField(decision.textFields.abstract),
      headnote: projectTextField(decision.textFields.headnote),
      legalSentence: projectTextField(decision.textFields.legalSentence),
      summary: projectTextField(decision.textFields.summary),
    },
    source: {
      ...decision.source,
      name: truncateTextBytes(decision.source.name, 256 * 4),
      adapterKey: truncateTextBytes(decision.source.adapterKey, 64 * 4),
    },
    judges: decision.judges.slice(0, JUDGES_MAX).map((judge) => ({
      role: judge.role,
      judgeId: judge.judgeId,
      name: truncateTextBytes(judge.name, LABEL_BYTES),
      portrait:
        judge.portrait === null
          ? null
          : {
              url: truncateTextBytes(judge.portrait.url, URL_BYTES),
              attribution: truncateTextBytes(
                judge.portrait.attribution,
                LABEL_BYTES,
              ),
            },
    })),
    citationsFrom: decision.citationsFrom.map((citation) => ({
      ...citation,
      citationText: truncateTextBytes(citation.citationText, PROSE_BYTES),
    })),
    citationsTo: decision.citationsTo.map((citation) => ({
      ...citation,
      citationText: truncateTextBytes(citation.citationText, PROSE_BYTES),
    })),
    caseFile: {
      ...decision.caseFile,
      items: decision.caseFile.items.map((item) => ({
        ...item,
        caseNumber: truncateTextBytes(item.caseNumber, text.caseNumber),
        country: truncateTextBytes(item.country, text.country),
        court: truncateTextBytes(item.court, text.court),
        decisionDate: nullableText(item.decisionDate, text.decisionDate),
        decisionType: nullableText(item.decisionType, text.decisionType),
        ecli: nullableText(item.ecli, text.ecli),
        language: truncateTextBytes(item.language, text.language),
        languageGroupKey: nullableText(
          item.languageGroupKey,
          text.languageGroupKey,
        ),
        slug: nullableText(item.slug, text.slug),
        languageAlternates: item.languageAlternates.map(({ language }) => ({
          language: truncateTextBytes(language, text.language),
        })),
      })),
    },
    languageAlternates: decision.languageAlternates.map((alternate) => ({
      id: truncateTextBytes(alternate.id, 36),
      caseNumber: truncateTextBytes(alternate.caseNumber, text.caseNumber),
      country: truncateTextBytes(alternate.country, text.country),
      court: truncateTextBytes(alternate.court, text.court),
      decisionDate: nullableText(alternate.decisionDate, text.decisionDate),
      language: truncateTextBytes(alternate.language, text.language),
      slug: nullableText(alternate.slug, text.slug),
      hasDocument: alternate.hasDocument,
    })),
  };
};
