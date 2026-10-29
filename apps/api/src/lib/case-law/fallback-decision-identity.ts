// parser-output-unchanged: fallback storage identity is derived after parsing; adapter output is unchanged.
import { panic, Result } from "better-result";

import { sha256Hex } from "@stll/sha256/bun";

import { listingCourtIdentity } from "@/api/lib/case-law/decision-court-identity";
import type { ListingCourtIdentity } from "@/api/lib/case-law/decision-court-identity";
import { FALLBACK_DECISION_IDENTITY_PREFIX } from "@/api/lib/case-law/fallback-decision-identity-constants";
import { toPlainText } from "@/api/lib/case-law/plain-text";
import {
  corpusContentHash,
  EMPTY_CORPUS_CONTENT_HASHES,
} from "@/api/lib/legal-search/corpus-content-hash";
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
  if (court.type !== "unknown-court" && ecli.length > 0) {
    return {
      type: "decision",
      language,
      court,
      caseNumber,
      evidence: { type: "ecli", value: ecli },
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

/** Reuse the canonical normalized document hash; transport envelopes and weak metadata do not identify a document. */
const publishedDocumentHash = (result: IngestionResult): string => {
  const hash = corpusContentHash(caseLawCanonicalPayload(result));
  // A listing-only publication still exposes a record worth retaining. Its
  // normalized stated fields are the content; transport headers are excluded.
  return EMPTY_CORPUS_CONTENT_HASHES.includes(hash)
    ? sha256Hex(
        JSON.stringify([
          "published-record",
          sortDeep({
            decisionDate: result.decisionDate,
            decisionType: result.decisionType,
            ecli: result.ecli,
            sheetNumber: result.sheetNumber,
            judges: result.judges,
            identifiers: result.identifiers,
            sourceUrl: result.sourceUrl,
            documentUrl: result.documentUrl,
            metadata: result.metadata,
            textFields: result.textFields,
          }),
        ]),
      )
    : hash;
};

export type DecisionStorageIdentity =
  | { type: "document"; sourceDocumentId: string }
  | {
      type: "strong";
      identity: Extract<FallbackDecisionIdentity, { type: "decision" }>;
      key: string;
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
    return { type: "strong", identity, key };
  }
  const publishedContentHash = publishedDocumentHash(result);
  // Weak date/type edits can move the cohort without duplicating its document.
  const contentHash = sha256Hex(
    JSON.stringify([
      identity.language,
      listingCourtTuple(identity.court),
      identity.caseNumber,
      publishedContentHash,
    ]),
  );
  return {
    type: "content",
    identity,
    cohortKey: key,
    contentHash,
    publishedContentHash,
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
      };
    case "strong":
      return {
        fallbackIdentityKey: storage.key,
        fallbackCohortKey: null,
        fallbackContentHash: null,
      };
    case "content":
      return {
        fallbackIdentityKey: null,
        fallbackCohortKey: storage.cohortKey,
        fallbackContentHash: storage.contentHash,
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
        { fallbackIdentityKey: storage.key },
        {
          ...legacyScope,
          ...(storage.identity.evidence.type === "ecli"
            ? { ecli: storage.identity.evidence.value }
            : { sheetNumber: storage.identity.evidence.value }),
        },
      ],
    };
  }
  return {
    sourceDocumentId: ABSENT_FIELD,
    OR: [
      { fallbackContentHash: storage.contentHash },
      {
        ...legacyScope,
        contentHash: storage.publishedContentHash,
        ecli: storage.identity.evidence.ecli ?? ABSENT_FIELD,
        sheetNumber: storage.identity.evidence.sheetNumber ?? ABSENT_FIELD,
        decisionDate: storage.identity.evidence.decisionDate ?? ABSENT_FIELD,
        decisionType: storage.identity.evidence.decisionType ?? ABSENT_FIELD,
      },
    ],
  };
};
