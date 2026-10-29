// parser-output-unchanged: fallback storage identity is derived after parsing; adapter output is unchanged.
import { panic, Result } from "better-result";
import { not } from "drizzle-orm";

import {
  DECISION_IDENTIFIER_TYPES,
  normalizeStructuredDecisionIdentifier,
} from "@stll/legal-ast/decision-identifier";
import { sha256Hex } from "@stll/sha256/bun";

import { listingCourtIdentity } from "@/api/lib/case-law/decision-court-identity";
import type { ListingCourtIdentity } from "@/api/lib/case-law/decision-court-identity";
import { splitStoredDecisionTextMetadata } from "@/api/lib/case-law/decision-text";
import { FALLBACK_DECISION_IDENTITY_PREFIX } from "@/api/lib/case-law/fallback-decision-identity-constants";
import { toPlainText } from "@/api/lib/case-law/plain-text";
import {
  payloadCarriesDocument,
  rowHoldsDocumentFor,
} from "@/api/lib/case-law/stored-payload";
import { corpusContentHash } from "@/api/lib/legal-search/corpus-content-hash";
import {
  decisionIdentifiersFromPersistedMetadata,
  storeDecisionIdentifiersInMetadata,
} from "@/api/lib/legal-search/decision-identifier-metadata";
import { caseLawCanonicalPayload } from "@/api/lib/legal-search/decision-payload";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { PARTIAL_OBSERVATION_KEY } from "@/api/lib/legal-search/partial-observation-sql";
import { sortDeep } from "@/api/lib/sort-deep";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

const MAX_KEY_LENGTH = 320;
const ABSENT_FIELD = { isNull: true } as const;

type FallbackIdentityFields = { language: string; caseNumber: string };
type StrongEvidence =
  { type: "ecli"; value: string } | { type: "sheet-number"; value: string };
type CohortEvidence = {
  ecli: string | null;
  sheetNumber: string | null;
  decisionDate: string | null;
  decisionType: string | null;
};

/** A weak tuple names a cohort; only published content can identify its individual members. */
export type FallbackDecisionIdentity =
  | (FallbackIdentityFields & {
      type: "decision";
      court: Exclude<ListingCourtIdentity, { type: "unknown-court" }>;
      evidence: StrongEvidence;
    })
  | (FallbackIdentityFields & {
      type: "multiple-decisions";
      court: ListingCourtIdentity;
      evidence: CohortEvidence;
    })
  | { type: "unidentifiable" };

type FallbackDecisionIdentityInput = {
  language: string;
  court: string;
  courtId?: string | null | undefined;
  caseNumber: string;
  ecli?: string | null | undefined;
  sheetNumber?: string | null | undefined;
  decisionDate?: string | null | undefined;
  decisionType?: string | null | undefined;
};

/** Listing and storage use the same field conversion and strength rules. */
export const fallbackDecisionIdentity = (
  input: FallbackDecisionIdentityInput,
): FallbackDecisionIdentity => {
  const fields = Result.all([
    toPlainText(input.language),
    toPlainText(input.caseNumber),
    toPlainText(input.ecli ?? ""),
    toPlainText(input.sheetNumber ?? ""),
    toPlainText(input.decisionDate ?? ""),
    toPlainText(input.decisionType ?? ""),
  ]);
  if (fields.isErr()) {
    return { type: "unidentifiable" };
  }
  const [language, caseNumber, ecli, sheetNumber, decisionDate, decisionType] =
    fields.value;
  if (language.length === 0 || caseNumber.length === 0) {
    return { type: "unidentifiable" };
  }
  const court = listingCourtIdentity(input);
  const normalizedEcli = normalizeStructuredDecisionIdentifier({
    type: DECISION_IDENTIFIER_TYPES.ECLI,
    value: ecli,
  });
  if (court.type !== "unknown-court" && normalizedEcli.length > 0) {
    return {
      type: "decision",
      language,
      court,
      caseNumber,
      evidence: { type: "ecli", value: normalizedEcli },
    };
  }
  if (court.type !== "unknown-court" && sheetNumber.length > 0) {
    return {
      type: "decision",
      language,
      court,
      caseNumber,
      evidence: { type: "sheet-number", value: sheetNumber },
    };
  }
  return {
    type: "multiple-decisions",
    language,
    court,
    caseNumber,
    evidence: {
      ecli: ecli || null,
      sheetNumber: sheetNumber || null,
      decisionDate: decisionDate || null,
      decisionType: decisionType || null,
    },
  };
};

const listingCourtTuple = (court: ListingCourtIdentity) => {
  switch (court.type) {
    case "unknown-court":
      return [court.type] as const;
    case "court-id":
      return [court.type, court.courtId] as const;
    case "court-name":
      return [court.type, court.name] as const;
    default:
      court satisfies never;
      return panic("Unhandled listing court identity");
  }
};

const parseListingCourtTuple = (
  value: unknown,
): ListingCourtIdentity | null => {
  if (!isUnknownArray(value)) {
    return null;
  }
  const [type, name] = value;
  switch (type) {
    case "unknown-court":
      return { type: "unknown-court" };
    case "court-id":
      return typeof name === "string" && name.length > 0
        ? { type: "court-id", courtId: name }
        : null;
    case "court-name":
      return typeof name === "string" && name.length > 0
        ? { type: "court-name", name }
        : null;
    default:
      return null;
  }
};

/** Strong keys exclude weak date/type; cohort keys preserve them without claiming uniqueness. */
export const fallbackDecisionIdentityKey = (
  identity: FallbackDecisionIdentity,
): string | null => {
  if (
    identity.type === "unidentifiable" ||
    identity.language.length === 0 ||
    identity.caseNumber.length === 0
  ) {
    return null;
  }
  if (
    (identity.court.type === "court-name" &&
      identity.court.name.length === 0) ||
    (identity.court.type === "court-id" &&
      identity.court.courtId.length === 0) ||
    (identity.type === "decision" && identity.evidence.value.length === 0)
  ) {
    return null;
  }
  const { court } = identity;
  const evidenceTuple =
    identity.type === "decision"
      ? [identity.evidence.type, identity.evidence.value]
      : [
          identity.evidence.ecli,
          identity.evidence.sheetNumber,
          identity.evidence.decisionDate,
          identity.evidence.decisionType,
        ];
  const key = `${FALLBACK_DECISION_IDENTITY_PREFIX}${JSON.stringify([identity.type, identity.language, listingCourtTuple(court), identity.caseNumber, evidenceTuple])}`;
  return key.length <= MAX_KEY_LENGTH ? key : null;
};

/** Deliberately adjacent to its serializer; old court-less shapes are refused. */
export const parseFallbackDecisionIdentityKey = (
  key: string,
): FallbackDecisionIdentity | null => {
  if (
    !key.startsWith(FALLBACK_DECISION_IDENTITY_PREFIX) ||
    key.length > MAX_KEY_LENGTH
  ) {
    return null;
  }
  const parsed = Result.try({
    try: (): unknown =>
      JSON.parse(key.slice(FALLBACK_DECISION_IDENTITY_PREFIX.length)),
    catch: () => null,
  }).unwrapOr(null);
  if (!isUnknownArray(parsed) || parsed.length !== 5) {
    return null;
  }
  const [type, language, courtTuple, caseNumber, evidenceTuple] = parsed;
  if (
    (type !== "decision" && type !== "multiple-decisions") ||
    typeof language !== "string" ||
    typeof caseNumber !== "string" ||
    !isUnknownArray(evidenceTuple)
  ) {
    return null;
  }
  const court = parseListingCourtTuple(courtTuple);
  if (court === null) {
    return null;
  }
  if (type === "decision") {
    const [kind, value] = evidenceTuple;
    if (
      court.type === "unknown-court" ||
      (kind !== "ecli" && kind !== "sheet-number") ||
      typeof value !== "string" ||
      value.length === 0
    ) {
      return null;
    }
    const identity = {
      type,
      language,
      court,
      caseNumber,
      evidence: { type: kind, value },
    } as const satisfies FallbackDecisionIdentity;
    return fallbackDecisionIdentityKey(identity) === key ? identity : null;
  }
  const [ecli, sheetNumber, decisionDate, decisionType] = evidenceTuple;
  if (
    (ecli !== null && typeof ecli !== "string") ||
    (sheetNumber !== null && typeof sheetNumber !== "string") ||
    (decisionDate !== null && typeof decisionDate !== "string") ||
    (decisionType !== null && typeof decisionType !== "string")
  ) {
    return null;
  }
  const identity = {
    type,
    language,
    court,
    caseNumber,
    evidence: { ecli, sheetNumber, decisionDate, decisionType },
  } as const satisfies FallbackDecisionIdentity;
  return fallbackDecisionIdentityKey(identity) === key ? identity : null;
};

type PublicationFieldsInput = {
  decisionDate?: string | null | undefined;
  ecli?: string | null | undefined;
  sheetNumber?: string | null | undefined;
  decisionType?: string | null | undefined;
  judges?: readonly unknown[] | null | undefined;
  sourceUrl?: string | null | undefined;
  documentUrl?: string | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
  hasStoredDocument?: boolean;
};

/** Availability describes the observation, not contradictory publication evidence. */
const OBSERVATION_METADATA_KEYS = new Set([
  PARTIAL_OBSERVATION_KEY,
  "sourceUrlStatus",
  "ecliAvailability",
  "decisionDateAvailability",
  "detailUnavailable",
]);

const publicationEvidence = (result: PublicationFieldsInput) => ({
  ecli: fallbackEcliComparisonKey(result.ecli ?? "") || undefined,
  sheetNumber: result.sheetNumber,
});

const publicationFields = (result: PublicationFieldsInput) => {
  const metadata = splitStoredDecisionTextMetadata(
    result.metadata ?? {},
  ).metadata;
  const identifiers = decisionIdentifiersFromPersistedMetadata(metadata);
  return {
    decisionDate: result.decisionDate,
    decisionType: result.decisionType,
    evidence: publicationEvidence(result),
    judges: result.judges,
    sourceUrl: result.sourceUrl,
    documentUrl: result.documentUrl,
    identifiers: identifiers?.map((identifier) => ({
      type: identifier.type,
      value:
        identifier.type === DECISION_IDENTIFIER_TYPES.ECLI
          ? normalizeStructuredDecisionIdentifier(identifier)
          : identifier.value,
    })),
    metadata: Object.fromEntries(
      Object.entries(
        storeDecisionIdentifiersInMetadata(metadata, undefined),
      ).filter(([key]) => !OBSERVATION_METADATA_KEYS.has(key)),
    ),
  };
};

/** Absence is not evidence; every value stated by both observations must agree.
 * Collections may gain members on enrichment, but disjoint stated collections conflict.
 */
const sharedPublicationFieldsAgree = ({
  left,
  right,
  mode,
}: {
  left: unknown;
  right: unknown;
  mode: "shared" | "contained";
}): boolean => {
  if (left === undefined || left === null || left === "") {
    return true;
  }
  if (right === undefined || right === null || right === "") {
    return mode === "shared";
  }
  if (isUnknownArray(left) && isUnknownArray(right)) {
    const [smaller, larger] =
      mode === "contained" || left.length <= right.length
        ? [left, right]
        : [right, left];
    return smaller.every((entry) =>
      larger.some(
        (other) =>
          JSON.stringify(sortDeep(entry)) === JSON.stringify(sortDeep(other)),
      ),
    );
  }
  if (isRecord(left) && isRecord(right)) {
    return Object.entries(left).every(([key, value]) =>
      sharedPublicationFieldsAgree({ left: value, right: right[key], mode }),
    );
  }
  return left === right;
};

export const decisionPublicationCompatible = (
  storage: DecisionStorageIdentity,
  stored: PublicationFieldsInput,
) =>
  (storage.type === "content" || storage.type === "strong") &&
  sharedPublicationFieldsAgree({
    left: storage.publicationFields,
    right: publicationFields(stored),
    mode:
      storage.type === "content" &&
      storage.documentState === "metadata-only" &&
      stored.hasStoredDocument
        ? "contained"
        : "shared",
  });

/** Equal document text does not override contradictory publication evidence. */
export const decisionContentEvidenceCompatible = (
  storage: DecisionStorageIdentity,
  stored: PublicationFieldsInput,
) =>
  (storage.type === "content" || storage.type === "strong") &&
  sharedPublicationFieldsAgree({
    left: storage.publicationFields.evidence,
    right: publicationEvidence(stored),
    mode: "shared",
  });

const scopedPublicationHash = (
  identity: Exclude<FallbackDecisionIdentity, { type: "unidentifiable" }>,
  publishedHash: string,
) =>
  sha256Hex(
    JSON.stringify([
      identity.language,
      listingCourtTuple(identity.court),
      identity.caseNumber,
      publishedHash,
    ]),
  );

const scopedDocumentHash = ({
  identity,
  evidence,
  publishedContentHash,
}: {
  identity: Exclude<FallbackDecisionIdentity, { type: "unidentifiable" }>;
  evidence: ReturnType<typeof publicationEvidence>;
  publishedContentHash: string;
}) =>
  scopedPublicationHash(
    identity,
    sha256Hex(JSON.stringify([evidence, publishedContentHash])),
  );

export type DecisionStorageIdentity =
  | { type: "document"; sourceDocumentId: string }
  | {
      type: "strong";
      publishedContentHash: string | null;
      identity: Extract<FallbackDecisionIdentity, { type: "decision" }>;
      key: string;
      publicationHash: string;
      publicationFields: ReturnType<typeof publicationFields>;
      aliases: readonly {
        identity: Extract<FallbackDecisionIdentity, { type: "decision" }>;
        key: string;
      }[];
    }
  | {
      type: "content";
      identity: Extract<
        FallbackDecisionIdentity,
        { type: "multiple-decisions" }
      >;
      cohortKey: string;
      contentHash: string;
      publishedContentHash: string;
      publicationHash: string;
      publicationFields: ReturnType<typeof publicationFields>;
      documentState: "metadata-only" | "document";
    }
  | { type: "unkeyable"; identity: FallbackDecisionIdentity };

/** Publisher ids avoid hashing payloads; fallback evidence also carries canonical content proof. */
export const decisionStorageIdentity = (
  result: IngestionResult,
): DecisionStorageIdentity => {
  if (result.sourceDocumentId) {
    return { type: "document", sourceDocumentId: result.sourceDocumentId };
  }
  const identity = fallbackDecisionIdentity(result);
  const key = fallbackDecisionIdentityKey(identity);
  if (key === null || identity.type === "unidentifiable") {
    return { type: "unkeyable", identity };
  }
  const publicationHash = scopedPublicationHash(identity, "");
  if (identity.type === "decision") {
    const sheetIdentity = fallbackDecisionIdentity({
      ...result,
      ecli: undefined,
    });
    const sheetKey = fallbackDecisionIdentityKey(sheetIdentity);
    const aliases = [{ identity, key }];
    if (
      sheetIdentity.type === "decision" &&
      sheetKey !== null &&
      sheetKey !== key
    ) {
      aliases.push({ identity: sheetIdentity, key: sheetKey });
    }
    return {
      type: "strong",
      publishedContentHash: payloadCarriesDocument(
        caseLawCanonicalPayload(result),
      )
        ? corpusContentHash(caseLawCanonicalPayload(result))
        : null,
      identity,
      key,
      aliases,
      publicationHash,
      publicationFields: publicationFields(result),
    };
  }
  const publishedContentHash = corpusContentHash(
    caseLawCanonicalPayload(result),
  );
  const documentState = payloadCarriesDocument(caseLawCanonicalPayload(result))
    ? "document"
    : "metadata-only";
  // The nonunique scope stays stable as publication fields and document content arrive.
  const contentHash =
    documentState === "metadata-only"
      ? scopedPublicationHash(
          identity,
          sha256Hex(
            JSON.stringify(
              sortDeep({
                publicationHash,
                publicationFields: publicationFields(result),
                metadata: result.metadata,
                textFields: result.textFields,
              }),
            ),
          ),
        )
      : scopedDocumentHash({
          identity,
          evidence: publicationEvidence(result),
          publishedContentHash,
        });
  return {
    type: "content",
    identity,
    cohortKey: key,
    contentHash,
    publishedContentHash,
    publicationHash,
    publicationFields: publicationFields(result),
    documentState,
  };
};

/** Typed columns derive from the identity branch rather than hand-maintained parallel fields. */
export const decisionFallbackColumns = (storage: DecisionStorageIdentity) => {
  switch (storage.type) {
    case "document":
      return {
        fallbackIdentityKey: null,
        fallbackCohortKey: null,
        fallbackContentHash: null,
        fallbackPublicationHash: null,
      };
    case "strong":
      return {
        fallbackIdentityKey: storage.key,
        fallbackCohortKey: null,
        fallbackContentHash: null,
        fallbackPublicationHash: storage.publicationHash,
      };
    case "content":
      return {
        fallbackIdentityKey: null,
        fallbackCohortKey: storage.cohortKey,
        fallbackContentHash: storage.contentHash,
        fallbackPublicationHash: storage.publicationHash,
      };
    case "unkeyable":
      return panic("An unkeyable identity cannot be persisted as a decision");
    default:
      storage satisfies never;
      return panic("Unhandled decision storage identity");
  }
};

/** Exact indexed identity, with content proof for rows predating the new columns. */
export const decisionStorageIdentityMatch = (
  storage: DecisionStorageIdentity,
) => {
  if (storage.type === "document") {
    return { sourceDocumentId: storage.sourceDocumentId };
  }
  if (storage.type === "unkeyable") {
    return panic("An unkeyable identity cannot select a stored decision");
  }
  const { identity } = storage;
  const courtFields =
    identity.court.type === "court-id"
      ? { courtId: identity.court.courtId }
      : {
          courtId: ABSENT_FIELD,
          court:
            identity.court.type === "court-name" ? identity.court.name : "",
        };
  const legacyScope = {
    fallbackIdentityKey: ABSENT_FIELD,
    fallbackCohortKey: ABSENT_FIELD,
    caseNumber: identity.caseNumber,
    language: identity.language,
    ...courtFields,
  };
  if (storage.type === "strong") {
    return {
      sourceDocumentId: ABSENT_FIELD,
      OR: [
        { fallbackIdentityKey: { in: storage.aliases.map(({ key }) => key) } },
        ...storage.aliases.flatMap(({ identity: alias }) =>
          alias.evidence.type === "sheet-number"
            ? [{ ...legacyScope, sheetNumber: alias.evidence.value }]
            : [],
        ),
      ],
    };
  }
  return {
    sourceDocumentId: ABSENT_FIELD,
    OR: [
      { fallbackContentHash: storage.contentHash },
      ...(storage.documentState === "document"
        ? [
            {
              ...legacyScope,
              ...(identity.court.type === "unknown-court"
                ? {}
                : { ecli: ABSENT_FIELD, sheetNumber: ABSENT_FIELD }),
              contentHash: storage.publishedContentHash,
            },
          ]
        : []),
    ],
  };
};

/** Full documents adopt textless publications or a weak full row with canonical content proof.
 * Metadata-only replay may reuse an unambiguous publication; callers require exactly one candidate.
 */
export const decisionStorageEnrichmentMatch = (
  storage: DecisionStorageIdentity,
) => {
  if (storage.type !== "content" && storage.type !== "strong") {
    return null;
  }
  const legacy = {
    fallbackPublicationHash: ABSENT_FIELD,
    fallbackIdentityKey: ABSENT_FIELD,
    fallbackCohortKey: ABSENT_FIELD,
    language: storage.identity.language,
    caseNumber: storage.identity.caseNumber,
    ...fallbackDecisionCourtMatch(storage.identity),
    // A legacy known-court ECLI/sheet already names a strong publication.
    ...(storage.identity.court.type === "unknown-court"
      ? {}
      : { ecli: ABSENT_FIELD, sheetNumber: ABSENT_FIELD }),
    RAW: (table: Parameters<typeof rowHoldsDocumentFor>[0]) =>
      not(rowHoldsDocumentFor(table)),
  };
  const scope = {
    sourceDocumentId: ABSENT_FIELD,
    OR: [{ fallbackPublicationHash: storage.publicationHash }, legacy],
  };
  if (storage.type === "strong" || storage.documentState === "document") {
    const textless = {
      ...scope,
      fallbackIdentityKey: ABSENT_FIELD,
      RAW: (table: Parameters<typeof rowHoldsDocumentFor>[0]) =>
        not(rowHoldsDocumentFor(table)),
    };
    if (storage.type !== "strong" || storage.publishedContentHash === null) {
      return textless;
    }
    return {
      OR: [
        textless,
        {
          sourceDocumentId: ABSENT_FIELD,
          fallbackIdentityKey: ABSENT_FIELD,
          language: storage.identity.language,
          caseNumber: storage.identity.caseNumber,
          ...fallbackDecisionCourtMatch(storage.identity),
          OR: [
            { contentHash: storage.publishedContentHash },
            {
              fallbackContentHash: scopedDocumentHash({
                identity: storage.identity,
                evidence: publicationEvidence({}),
                publishedContentHash: storage.publishedContentHash,
              }),
            },
          ],
        },
      ],
    };
  }
  return {
    ...scope,
    AND: [
      {
        OR: [
          { fallbackIdentityKey: ABSENT_FIELD },
          { RAW: rowHoldsDocumentFor },
        ],
      },
    ],
  };
};

/** Same owner as citation identifiers; spelling changes do not create ECLI aliases. */
export const fallbackEcliComparisonKey = (value: string) =>
  normalizeStructuredDecisionIdentifier({
    type: DECISION_IDENTIFIER_TYPES.ECLI,
    value,
  });

export const fallbackDecisionCourtMatch = (
  identity: Exclude<FallbackDecisionIdentity, { type: "unidentifiable" }>,
) =>
  identity.court.type === "court-id"
    ? { courtId: identity.court.courtId }
    : {
        courtId: ABSENT_FIELD,
        court: identity.court.type === "court-name" ? identity.court.name : "",
      };

export const decisionStorageLockKeys = (
  storage: DecisionStorageIdentity,
): string[] => {
  switch (storage.type) {
    case "strong":
      return [
        ...storage.aliases.map(({ key }) => key),
        `publication:${storage.publicationHash}`,
      ].toSorted();
    case "content":
      return [
        `content:${storage.contentHash}`,
        `publication:${storage.publicationHash}`,
      ].toSorted();
    case "document":
      return [];
    case "unkeyable":
      return panic("Unkeyable decisions have no storage lock");
    default:
      storage satisfies never;
      return panic("Unhandled storage lock identity");
  }
};
