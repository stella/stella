import { collapseSpacedLetters } from "@stll/text-normalize";

import { isDocumentAst } from "@/api/lib/case-law/document-ast";
import { canonicalDecisionDate } from "@/api/lib/dates";
import {
  DANGEROUS_CHARS,
  sanitizeMetadata,
  stripDangerousChars,
} from "@/api/lib/legal-search/corpus-sanitize";
import {
  EMPTY_AST,
  isPersistableSourceDocumentId,
  type IngestionResult,
} from "@/api/lib/legal-search/ingestion-types";
import { isRecord } from "@/api/lib/type-guards";

/** Pipeline-owned quality marker persisted with partial source observations. */
const PARTIAL_OBSERVATION_KEY = "_stellaPartialObservation";

export type PartialObservation = {
  caseNumberIsPlaceholder: boolean;
  isListingOnly: boolean;
};

export const partialObservationFromMetadata = (
  metadata: unknown,
): PartialObservation => {
  const value = isRecord(metadata)
    ? metadata[PARTIAL_OBSERVATION_KEY]
    : undefined;
  return {
    caseNumberIsPlaceholder:
      isRecord(value) && value["caseNumberIsPlaceholder"] === true,
    isListingOnly: isRecord(value) && value["isListingOnly"] === true,
  };
};

/**
 * Sanitize text fields before DB insertion. Postgres rejects null bytes in
 * text columns. Keeping this at the ingestion boundary means adapters and
 * backfill jobs produce the same canonical representation.
 *
 * This is also where `decisionDate` is bounded: adapters normalize dates
 * differently or not at all, and the date column accepts an impossible year
 * as readily as a real one, so a value that cannot be a decision date is
 * dropped here rather than at each publisher boundary.
 */
export const sanitizeResult = (result: IngestionResult): IngestionResult => {
  const strip = (value: string | undefined): string | undefined =>
    value ? stripDangerousChars(value) : undefined;

  const DECISION_TYPE_NOISE =
    /česk[áa]\s+republik[ay]|jm[ée]nem\s+republik[ay]/giu;

  const normalizeDecisionType = (
    raw: string | undefined,
  ): string | undefined => {
    if (!raw) {
      return undefined;
    }
    return (
      raw.replace(DECISION_TYPE_NOISE, "").trim().toLowerCase() || undefined
    );
  };

  // A listed document must survive a bad date, so an unusable value is
  // dropped to null instead of failing the row.
  const boundDecisionDate = (raw: string | undefined): string | undefined => {
    if (raw === undefined) {
      return undefined;
    }
    return canonicalDecisionDate(raw) ?? undefined;
  };

  const deepSanitize = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") {
      const stripped = value
        .replace(DANGEROUS_CHARS, "")
        .replace(/\u00A0/gu, " ");
      return key === "plainText" ? collapseSpacedLetters(stripped) : stripped;
    }
    if (Array.isArray(value)) {
      return value.map((item) => deepSanitize(item));
    }
    if (isRecord(value)) {
      const sanitized: Record<string, unknown> = {};
      for (const [entryKey, entryValue] of Object.entries(value)) {
        sanitized[entryKey] = deepSanitize(entryValue, entryKey);
      }
      return sanitized;
    }
    return value;
  };

  const sanitizedDocumentAst = deepSanitize(result.documentAst);
  const documentAst = isDocumentAst(sanitizedDocumentAst)
    ? sanitizedDocumentAst
    : EMPTY_AST;

  const metadata = Object.fromEntries(
    Object.entries(sanitizeMetadata(result.metadata)).filter(
      ([key]) => key !== PARTIAL_OBSERVATION_KEY,
    ),
  );
  // Adapter metadata describes the publisher. Keep ingestion quality in a
  // reserved pipeline-owned marker so every court gets the same partial-row
  // upgrade/downgrade semantics without relying on court-specific keys.
  if (
    result.caseNumberIsPlaceholder === true ||
    result.isListingOnly === true
  ) {
    metadata[PARTIAL_OBSERVATION_KEY] = {
      caseNumberIsPlaceholder: result.caseNumberIsPlaceholder === true,
      isListingOnly: result.isListingOnly === true,
    };
  }

  const sourceDocumentId = strip(result.sourceDocumentId);
  if (
    result.sourceDocumentId !== undefined &&
    sourceDocumentId !== result.sourceDocumentId
  ) {
    throw new TypeError("Publisher document identity cannot be sanitized");
  }
  if (
    sourceDocumentId !== undefined &&
    !isPersistableSourceDocumentId(sourceDocumentId)
  ) {
    throw new TypeError("Publisher document identity exceeds storage limits");
  }

  return {
    ...result,
    caseNumber: result.caseNumber.replace(DANGEROUS_CHARS, ""),
    sourceDocumentId,
    sourceDocumentIdAliases: result.sourceDocumentIdAliases?.filter(
      (identity): identity is string =>
        strip(identity) === identity && isPersistableSourceDocumentId(identity),
    ),
    sourceDocumentIdRepairAliases: result.sourceDocumentIdRepairAliases?.filter(
      (identity): identity is string =>
        strip(identity) === identity && isPersistableSourceDocumentId(identity),
    ),
    legacySourceUrls: result.legacySourceUrls
      ?.map((url) => strip(url))
      .filter((url): url is string => url !== undefined),
    sheetNumber: strip(result.sheetNumber),
    fulltext: result.fulltext
      ? collapseSpacedLetters(strip(result.fulltext) ?? "")
      : undefined,
    ecli: strip(result.ecli),
    decisionDate: boundDecisionDate(result.decisionDate),
    decisionType: normalizeDecisionType(strip(result.decisionType)),
    sourceUrl: strip(result.sourceUrl),
    documentUrl: strip(result.documentUrl),
    metadata,
    publisherCitedCases: result.publisherCitedCases?.map((cited) =>
      stripDangerousChars(cited),
    ),
    sections: result.sections?.map((section) => ({
      ...section,
      title: section.title === null ? null : stripDangerousChars(section.title),
      text: collapseSpacedLetters(strip(section.text) ?? ""),
    })),
    documentAst,
    sourceRaw: strip(result.sourceRaw),
  };
};
