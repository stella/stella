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
import { FALLBACK_DECISION_IDENTITY_PREFIX } from "@/api/lib/case-law/fallback-decision-identity-constants";
import { toPlainText } from "@/api/lib/case-law/plain-text";
import {
  payloadCarriesDocument,
  rowHoldsDocumentFor,
} from "@/api/lib/case-law/stored-payload";
import { corpusContentHash } from "@/api/lib/legal-search/corpus-content-hash";
import { caseLawCanonicalPayload } from "@/api/lib/legal-search/decision-payload";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { sortDeep } from "@/api/lib/sort-deep";
import { isUnknownArray } from "@/api/lib/type-guards";

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

/** Only publication fields shared by listing and detail participate; enrichment payloads do not. */
const publicationFieldsHash = (result: IngestionResult) =>
  sha256Hex(
    JSON.stringify(
      sortDeep({
        decisionDate: result.decisionDate,
        decisionType: result.decisionType,
        judges: result.judges,
        identifiers: result.identifiers,
        sourceUrl: result.sourceUrl,
        documentUrl: result.documentUrl,
      }),
    ),
  );

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

export type DecisionStorageIdentity =
  | { type: "document"; sourceDocumentId: string }
  | {
      type: "strong";
      identity: Extract<FallbackDecisionIdentity, { type: "decision" }>;
      key: string;
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
      documentState: "metadata-only" | "document";
    }
  | { type: "unkeyable"; identity: FallbackDecisionIdentity };

/** Publisher ids and strong evidence avoid touching a document's potentially large payload. */
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
    return { type: "strong", identity, key, aliases };
  }
  const publicationHash = scopedPublicationHash(
    identity,
    publicationFieldsHash(result),
  );
  const publishedContentHash = corpusContentHash(
    caseLawCanonicalPayload(result),
  );
  const documentState = payloadCarriesDocument(caseLawCanonicalPayload(result))
    ? "document"
    : "metadata-only";
  // The stable publication fingerprint bridges enrichment; content still distinguishes siblings.
  const contentHash =
    documentState === "metadata-only"
      ? scopedPublicationHash(
          identity,
          sha256Hex(
            JSON.stringify(
              sortDeep({
                publicationHash,
                metadata: result.metadata,
                textFields: result.textFields,
              }),
            ),
          ),
        )
      : scopedPublicationHash(identity, publishedContentHash);
  return {
    type: "content",
    identity,
    cohortKey: key,
    contentHash,
    publishedContentHash,
    publicationHash,
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
        fallbackPublicationHash: null,
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
              contentHash: storage.publishedContentHash,
            },
          ]
        : []),
    ],
  };
};

/** A full document can adopt only a textless publication, never another full sibling.
 * Metadata-only replay may reuse an unambiguous publication; callers require exactly one candidate.
 */
export const decisionStorageEnrichmentMatch = (
  storage: DecisionStorageIdentity,
) => {
  if (storage.type !== "content") {
    return null;
  }
  return {
    sourceDocumentId: ABSENT_FIELD,
    fallbackPublicationHash: storage.publicationHash,
    RAW: (table: Parameters<typeof rowHoldsDocumentFor>[0]) =>
      storage.documentState === "document"
        ? not(rowHoldsDocumentFor(table))
        : rowHoldsDocumentFor(table),
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
      return storage.aliases.map(({ key }) => key).toSorted();
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
