import { panic } from "better-result";

import { storedDecisionDocketOf } from "@stll/api-contract/decision-docket-grammar";
import { DECISION_DOCUMENT_ROLE_METADATA_KEY } from "@stll/api-contract/decision-document-role";
import {
  DECISION_IDENTIFIER_MAX_COUNT,
  isDecisionIdentifier,
  type DecisionIdentifier,
  type DecisionIdentifiers,
} from "@stll/legal-ast/decision-identifier";
import {
  isDocumentAst,
  withProjectedPlainText,
} from "@stll/legal-ast/document-ast";
import { collapseSpacedLetters } from "@stll/text-normalize";

import { fitsCitationStorageField } from "@/api/lib/case-law/citation-storage-bounds";
import {
  DECISION_TEXT_FIELD,
  TEXT_ABSENCE_REASON,
  TEXT_FIELD_TYPE,
  absentTextField,
  presentTextField,
  storeDecisionTextFields,
  type DecisionTextFields,
  type TextField,
} from "@/api/lib/case-law/decision-text";
import { fitsSearchCandidateRow } from "@/api/lib/case-law/search-candidate-row-bound-sql";
import { canonicalDecisionDate } from "@/api/lib/dates";
import {
  UNPERSISTABLE_DECISION_FIELDS,
  UnpersistableDecisionFieldError,
} from "@/api/lib/errors/tagged-errors";
import {
  DANGEROUS_CHARS,
  sanitizeMetadata,
  stripDangerousChars,
} from "@/api/lib/legal-search/corpus-sanitize";
import { storeDecisionIdentifiersInMetadata } from "@/api/lib/legal-search/decision-identifier-metadata";
import {
  assertDecisionLanguageIdentity,
  decisionLanguageGroupKey,
} from "@/api/lib/legal-search/decision-language-identity";
import {
  DEFAULT_PRIMARY_REFERENCE_TYPE,
  parsePrimaryReferenceType,
} from "@/api/lib/legal-search/decision-primary-reference";
import {
  EMPTY_AST,
  isPersistableSourceDocumentId,
  type IngestionResult,
  type RawIngestionResult,
} from "@/api/lib/legal-search/ingestion-types";
import {
  OBSERVATION_DETAIL,
  observationDetailOf,
  PARTIAL_OBSERVATION_FIELD,
  PARTIAL_OBSERVATION_KEY,
  type PartialObservation,
} from "@/api/lib/legal-search/partial-observation-sql";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { isRecord } from "@/api/lib/type-guards";

// Source IDs are UUIDs: every real source contributes the same 36 ASCII
// bytes. Adapters can validate the generated index key before they know it.
const BYTE_BUDGET_SOURCE_UUID = "00000000-0000-0000-0000-000000000000";

type DecisionSearchCandidate = Pick<
  RawIngestionResult,
  | "caseNumber"
  | "country"
  | "court"
  | "decisionType"
  | "ecli"
  | "sourceDocumentId"
>;

export const fitsDecisionSearchCandidateRow = (
  result: DecisionSearchCandidate,
): boolean =>
  fitsSearchCandidateRow({
    court: result.court,
    decisionType: result.decisionType,
    languageGroupKey: decisionLanguageGroupKey({
      caseNumber: result.caseNumber,
      country: result.country,
      ecli: result.ecli,
      sourceDocumentId: result.sourceDocumentId,
      sourceId: BYTE_BUDGET_SOURCE_UUID,
    }),
  });

/** Refuse the court only when omitting it repairs the shared storage budget. */
export const decisionCourtExceedsStorage = (
  candidate: DecisionSearchCandidate,
): boolean =>
  !fitsCitationStorageField("court", candidate.court) ||
  (!fitsDecisionSearchCandidateRow(candidate) &&
    fitsDecisionSearchCandidateRow({ ...candidate, court: "" }));

const DECISION_TYPE_NOISE =
  /česk[áa]\s+republik[ay]|jm[ée]nem\s+republik[ay]/giu;

const normalizeDecisionType = (raw: string | undefined): string | undefined =>
  raw
    ? raw.replace(DECISION_TYPE_NOISE, "").trim().toLowerCase() || undefined
    : undefined;

const sanitizeDecisionIdentifier = (
  identifier: DecisionIdentifier,
): DecisionIdentifier => {
  const sanitized = {
    type: identifier.type,
    value: stripDangerousChars(identifier.value).trim(),
  };
  if (!isDecisionIdentifier(sanitized)) {
    throw new UnpersistableDecisionFieldError({
      message: "Decision identifier is not persistable",
      field: UNPERSISTABLE_DECISION_FIELDS.IDENTIFIER,
    });
  }
  return sanitized;
};

const sanitizeDecisionIdentifiers = (
  identifiers: DecisionIdentifiers | undefined,
): DecisionIdentifiers | undefined => {
  if (identifiers === undefined) {
    return undefined;
  }
  if (identifiers.length > DECISION_IDENTIFIER_MAX_COUNT) {
    throw new UnpersistableDecisionFieldError({
      message: "Decision has too many publisher identifiers",
      field: UNPERSISTABLE_DECISION_FIELDS.IDENTIFIER_COUNT,
    });
  }
  const [first, ...rest] = identifiers;
  return [
    sanitizeDecisionIdentifier(first),
    ...rest.map(sanitizeDecisionIdentifier),
  ];
};

export const partialObservationFromMetadata = (
  metadata: unknown,
): PartialObservation => {
  const value = isRecord(metadata)
    ? metadata[PARTIAL_OBSERVATION_KEY]
    : undefined;
  const caseNumberIsPlaceholder =
    isRecord(value) &&
    value[PARTIAL_OBSERVATION_FIELD.CASE_NUMBER_IS_PLACEHOLDER] === true;
  if (
    isRecord(value) &&
    value[PARTIAL_OBSERVATION_FIELD.IS_LISTING_ONLY] === true
  ) {
    return { caseNumberIsPlaceholder, detail: OBSERVATION_DETAIL.LISTING_ONLY };
  }
  if (
    isRecord(value) &&
    value[PARTIAL_OBSERVATION_FIELD.DETAIL] ===
      OBSERVATION_DETAIL.SECONDARY_REFUSED
  ) {
    return {
      caseNumberIsPlaceholder,
      detail: OBSERVATION_DETAIL.SECONDARY_REFUSED,
    };
  }
  return { caseNumberIsPlaceholder, detail: OBSERVATION_DETAIL.COMPLETE };
};

/**
 * Metadata for a first write of a decision that carries no document: the
 * marker set, any marker field the adapter's own flags produced kept. The
 * JavaScript twin of `metadataMarkedListingOnly`.
 */
export const markListingOnly = (
  metadata: Record<string, unknown>,
): Record<string, unknown> => {
  const stored = metadata[PARTIAL_OBSERVATION_KEY];
  return {
    ...metadata,
    [PARTIAL_OBSERVATION_KEY]: {
      ...(isRecord(stored) ? stored : {}),
      [PARTIAL_OBSERVATION_FIELD.IS_LISTING_ONLY]: true,
      [PARTIAL_OBSERVATION_FIELD.DETAIL]: OBSERVATION_DETAIL.LISTING_ONLY,
    },
  };
};

/**
 * How an observed docket is stored, read against its jurisdiction's grammar.
 *
 * - `kept`: it parses as written, is a placeholder, is a primary reference
 *   other than a docket, or its jurisdiction has no grammar; stored as
 *   written.
 * - `trimmed`: a tail the grammar has no place for (`- II.`, a stray dot) is
 *   cut, and the docket is stored without it.
 * - `unkeyed`: the same tail, left in place because the observation names no
 *   publisher document. Such a row is found again by its docket, and a tail
 *   may be all that tells two of a docket's documents apart, so cutting it
 *   would merge them or orphan the stored row.
 * - `unparsed`: no docket the grammar accepts is in it; stored as written.
 */
export type ObservedDocket =
  | { type: "kept" }
  | { type: "trimmed"; caseNumber: string; removed: string }
  | { type: "unkeyed"; caseNumber: string; removed: string }
  | { type: "unparsed" };

export const observedDocketOf = (
  result: Pick<
    RawIngestionResult,
    | "caseNumber"
    | "caseNumberIsPlaceholder"
    | "caseNumberType"
    | "country"
    | "sourceDocumentId"
  >,
): ObservedDocket => {
  if (
    result.caseNumberIsPlaceholder === true ||
    (result.caseNumberType !== undefined &&
      result.caseNumberType !== DEFAULT_PRIMARY_REFERENCE_TYPE)
  ) {
    return { type: "kept" };
  }
  const stored = storedDecisionDocketOf(
    result.caseNumber.replace(DANGEROUS_CHARS, ""),
    result.country,
  );
  switch (stored.type) {
    case "canonical":
    case "ungoverned":
      return { type: "kept" };
    case "unparsed":
      return stored;
    case "trimmed":
      return {
        type: result.sourceDocumentId ? "trimmed" : "unkeyed",
        caseNumber: stored.caseNumber,
        removed: stored.removed,
      };
    default: {
      stored satisfies never;
      return panic(`Unhandled stored docket: ${String(stored)}`);
    }
  }
};

/**
 * The primary reference as the row stores it: control characters removed and,
 * for a keyed observation, the docket's trailing sheet cut. A comparison with
 * a stored row reads the observation through this, not raw, or a value the
 * write would store unchanged reads as changed on every pass.
 */
export const storedCaseNumberOf = (
  result: Parameters<typeof observedDocketOf>[0],
): string => {
  const docket = observedDocketOf(result);
  return docket.type === "trimmed"
    ? docket.caseNumber
    : result.caseNumber.replace(DANGEROUS_CHARS, "");
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
 *
 * The docket is read against its jurisdiction's grammar here too, for the
 * same reason (`observedDocketOf`). The adapter's metadata keeps the docket
 * as the publisher wrote it.
 */
export const sanitizeResult = (
  result: RawIngestionResult,
  metadataUrlSchema?: unknown,
): IngestionResult => {
  const strip = (value: string | undefined): string | undefined =>
    value ? stripDangerousChars(value) : undefined;

  // A listed document must survive a bad date, so an unusable value is
  // dropped to null instead of failing the row. The bounds are the
  // jurisdiction's own.
  const boundDecisionDate = (raw: string | undefined): string | undefined => {
    if (raw === undefined) {
      return undefined;
    }
    return canonicalDecisionDate(raw, result.country) ?? undefined;
  };

  const deepSanitize = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.replace(DANGEROUS_CHARS, "").replace(/\u00A0/gu, " ");
    }
    if (Array.isArray(value)) {
      return value.map((item) => deepSanitize(item));
    }
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([entryKey, entryValue]) => [
          entryKey,
          deepSanitize(entryValue),
        ]),
      );
    }
    return value;
  };

  // Block text is derived here, not sanitized in place: `projectPlainText`
  // recomputes every rebuildable `plainText` from the `inlines` stored
  // beside it, so the two can never drift and a public read may drop the
  // field entirely. It runs after `deepSanitize` because sanitization
  // rewrites inline text (no-break spaces become spaces), which can turn a
  // run into a collapsible one.
  const sanitizedDocumentAst = deepSanitize(result.documentAst);
  const documentAst = isDocumentAst(sanitizedDocumentAst)
    ? withProjectedPlainText(sanitizedDocumentAst)
    : EMPTY_AST;

  const identifiers = sanitizeDecisionIdentifiers(result.identifiers);
  const sanitizeTextField = (field: TextField): TextField => {
    switch (field.type) {
      case TEXT_FIELD_TYPE.ABSENT:
        return field;
      case TEXT_FIELD_TYPE.PRESENT: {
        const text = stripDangerousChars(field.text).trim();
        return text.length === 0
          ? absentTextField(TEXT_ABSENCE_REASON.PARSE_FAILED)
          : presentTextField(text);
      }
      default: {
        field satisfies never;
        return panic(`Unhandled decision text field: ${String(field)}`);
      }
    }
  };
  const textFields = {
    [DECISION_TEXT_FIELD.ABSTRACT]: sanitizeTextField(
      result.textFields[DECISION_TEXT_FIELD.ABSTRACT],
    ),
    [DECISION_TEXT_FIELD.HEADNOTE]: sanitizeTextField(
      result.textFields[DECISION_TEXT_FIELD.HEADNOTE],
    ),
    [DECISION_TEXT_FIELD.LEGAL_SENTENCE]: sanitizeTextField(
      result.textFields[DECISION_TEXT_FIELD.LEGAL_SENTENCE],
    ),
    [DECISION_TEXT_FIELD.SUMMARY]: sanitizeTextField(
      result.textFields[DECISION_TEXT_FIELD.SUMMARY],
    ),
  } as const satisfies DecisionTextFields;
  const storedMetadata = storeDecisionTextFields({
    metadata: result.metadata,
    textFields,
  });
  const metadata = storeDecisionIdentifiersInMetadata(
    Object.fromEntries(
      Object.entries(sanitizeMetadata(storedMetadata)).filter(
        ([key]) =>
          key !== PARTIAL_OBSERVATION_KEY &&
          key !== DECISION_DOCUMENT_ROLE_METADATA_KEY,
      ),
    ),
    identifiers,
  );
  if (result.documentRole !== undefined) {
    metadata[DECISION_DOCUMENT_ROLE_METADATA_KEY] = result.documentRole;
  }
  // Adapter metadata describes the publisher. Keep ingestion quality in a
  // reserved pipeline-owned marker so every court gets the same partial-row
  // upgrade/downgrade semantics without relying on court-specific keys.
  const observationDetail = observationDetailOf(result);
  if (
    result.caseNumberIsPlaceholder === true ||
    observationDetail !== OBSERVATION_DETAIL.COMPLETE
  ) {
    metadata[PARTIAL_OBSERVATION_KEY] = {
      caseNumberIsPlaceholder: result.caseNumberIsPlaceholder === true,
      detail: observationDetail,
      isListingOnly: observationDetail === OBSERVATION_DETAIL.LISTING_ONLY,
    };
  }

  const sourceDocumentId = strip(result.sourceDocumentId);
  if (
    result.sourceDocumentId !== undefined &&
    sourceDocumentId !== result.sourceDocumentId
  ) {
    throw new UnpersistableDecisionFieldError({
      message: "Publisher document identity cannot be sanitized",
      field: UNPERSISTABLE_DECISION_FIELDS.SOURCE_DOCUMENT_ID,
    });
  }
  if (
    sourceDocumentId !== undefined &&
    !isPersistableSourceDocumentId(sourceDocumentId)
  ) {
    throw new UnpersistableDecisionFieldError({
      message: "Publisher document identity exceeds storage limits",
      field: UNPERSISTABLE_DECISION_FIELDS.SOURCE_DOCUMENT_ID_LENGTH,
    });
  }

  const caseNumber = storedCaseNumberOf(result);
  const court = stripDangerousChars(result.court);
  if (!fitsCitationStorageField("caseNumber", caseNumber)) {
    throw new UnpersistableDecisionFieldError({
      message: "Decision number exceeds storage limits",
      field: UNPERSISTABLE_DECISION_FIELDS.CASE_NUMBER_LENGTH,
    });
  }
  if (!fitsCitationStorageField("court", court)) {
    throw new UnpersistableDecisionFieldError({
      message: "Decision court exceeds storage limits",
      field: UNPERSISTABLE_DECISION_FIELDS.COURT_LENGTH,
    });
  }

  assertDecisionLanguageIdentity({ country: result.country, sourceDocumentId });

  const decisionType = normalizeDecisionType(strip(result.decisionType));
  const ecli = strip(result.ecli);
  // The write planner checks aggregate index bytes against its actual language group key.

  return plainTextIngestionResult(
    {
      ...result,
      observationDetail,
      caseNumber,
      court,
      caseNumberType: parsePrimaryReferenceType(result.caseNumberType),
      identifiers,
      sourceDocumentId,
      sourceDocumentIdAliases: result.sourceDocumentIdAliases?.filter(
        (identity): identity is string =>
          strip(identity) === identity &&
          isPersistableSourceDocumentId(identity),
      ),
      sourceDocumentIdRepairAliases:
        result.sourceDocumentIdRepairAliases?.filter(
          (identity): identity is string =>
            strip(identity) === identity &&
            isPersistableSourceDocumentId(identity),
        ),
      legacySourceUrls: result.legacySourceUrls
        ?.map((url) => strip(url))
        .filter((url): url is string => url !== undefined),
      legacyEcli: strip(result.legacyEcli),
      sheetNumber: strip(result.sheetNumber),
      fulltext: result.fulltext
        ? collapseSpacedLetters(strip(result.fulltext) ?? "")
        : undefined,
      ecli,
      decisionDate: boundDecisionDate(result.decisionDate),
      decisionType,
      sourceUrl: strip(result.sourceUrl),
      documentUrl: strip(result.documentUrl),
      metadata,
      textFields,
      publisherCitedCases: result.publisherCitedCases?.map((cited) =>
        stripDangerousChars(cited),
      ),
      sections: result.sections?.map((section) => ({
        ...section,
        title:
          section.title === null ? null : stripDangerousChars(section.title),
        text: collapseSpacedLetters(strip(section.text) ?? ""),
      })),
      documentAst,
      sourceRaw: strip(result.sourceRaw),
    },
    metadataUrlSchema,
  );
};
