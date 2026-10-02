import { stripDangerousChars } from "@stll/legal-ast/text-sanitize";

import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import {
  EMPTY_AST,
  isPersistableSourceDocumentId,
  toPlainTextIngestionResult,
  type RawIngestionResult,
} from "@/api/lib/legal-search/ingestion-types";

const persistableIdentity = (value: string) =>
  isPersistableSourceDocumentId(value) && stripDangerousChars(value) === value;

/** A rejected label stays explicit and replayable without aborting synchronous source assembly. */
export const plainTextIngestionResult = <T extends RawIngestionResult>(
  raw: T,
) => {
  const result = toPlainTextIngestionResult(raw);
  if (result.isOk()) {
    return result.value;
  }
  const error = result.error;
  const quarantineId = `plaintext-quarantine:${new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([raw.country, raw.rawHash, raw.sourceRaw]))
    .digest("hex")}`;
  const sourceDocumentId =
    raw.sourceDocumentId !== undefined &&
    persistableIdentity(raw.sourceDocumentId)
      ? raw.sourceDocumentId
      : quarantineId;
  const { parserVersion } = raw;
  const quarantine = toPlainTextIngestionResult({
    country: raw.country,
    language: raw.language,
    courtId: raw.courtId,
    caseNumberType: raw.caseNumberType,
    decisionDate: raw.decisionDate,
    parserVersion,
    rawHash: raw.rawHash,
    sourceUrl: raw.sourceUrl,
    documentUrl: raw.documentUrl,
    legacySourceUrls: raw.legacySourceUrls,
    sourceRaw: raw.sourceRaw,
    sourceRawContentType: raw.sourceRawContentType,
    sourceRawBytes: raw.sourceRawBytes,
    sourceRawObjects: raw.sourceRawObjects,
    plainTextOutcome: { type: "accepted" as const },
    sourceDocumentId,
    sourceDocumentIdAliases:
      raw.sourceDocumentIdAliases?.filter(persistableIdentity),
    sourceDocumentIdRepairAliases:
      raw.sourceDocumentIdRepairAliases?.filter(persistableIdentity),
    caseNumber: quarantineId,
    caseNumberIsPlaceholder: true,
    isListingOnly: true,
    documentDelivery: undefined,
    court: "",
    sheetNumber: undefined,
    ecli: undefined,
    legacyEcli: undefined,
    decisionType: undefined,
    identifiers: undefined,
    publisherCitedCases: undefined,
    judges: undefined,
    fulltext: undefined,
    documentAst: EMPTY_AST,
    sections: undefined,
    citationScopes: undefined,
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    metadata: {
      listedOnly: true,
      listedOnlyReason: "item_build_failed",
      detailStatus: "item_build_failed",
      plainTextFailureReason: error.reason,
    },
  }).unwrap("Plain-text quarantine contains only constructed safe labels");
  return {
    ...quarantine,
    plainTextOutcome: { type: "item_build_failed", error } as const,
  };
};
