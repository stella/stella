import { panic, Result } from "better-result";

import {
  composeCourtListenerText,
  type CourtListenerTextOutcome,
} from "@/api/handlers/case-law/ingestion/parsers/courtlistener/compose";
import {
  absentTextField,
  checkedDecisionMetadata,
  presentTextField,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { IMPORT_SOURCE_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import type {
  IngestionResult,
  StoredRawReparseInput,
  StoredRawReparseOutcome,
} from "@/api/lib/legal-search/ingestion-types";
import { STORED_RAW_REPARSE_REJECTION } from "@/api/lib/legal-search/ingestion-types";

import { classifyCourtListenerDecision } from "./order-classification";
import { planCourtListenerRecord } from "./plan";
import { decodeCourtListenerRaw } from "./raw";
import { admitCourtListenerRecord } from "./record";
import {
  COURTLISTENER_REJECTION_REASON,
  type CourtListenerRecordRejectedError,
  rejectCourtListenerRecord,
} from "./rejection";
import { hasVisibleText } from "./snapshot-columns";

export const COURTLISTENER_IMPORT_KEY = IMPORT_SOURCE_KEYS.COURTLISTENER;
export const COURTLISTENER_PARSER_VERSION = 3;

const textField = (value: string) =>
  hasVisibleText(value)
    ? presentTextField(value)
    : absentTextField(TEXT_ABSENCE_REASON.NOT_PUBLISHED);

export const courtListenerTextRejectionReason = (
  outcome: Exclude<CourtListenerTextOutcome, { status: "parsed" }>,
) => {
  switch (outcome.status) {
    case "held":
      return outcome.reason;
    case "scope-defect":
      return COURTLISTENER_REJECTION_REASON.SCOPE_DEFECT;
    default:
      outcome satisfies never;
      return panic("Unhandled CourtListener text rejection");
  }
};

export const mapCourtListenerRecord = (
  input: unknown,
): Result<IngestionResult, CourtListenerRecordRejectedError> => {
  const planned = planCourtListenerRecord(input);
  if (Result.isError(planned)) {
    return Result.err(planned.error);
  }
  const admitted = admitCourtListenerRecord(input);
  if (Result.isError(admitted)) {
    return Result.err(admitted.error);
  }
  const { record, opinions, sourceRecordKey, clusterId } = admitted.value;
  const composed = composeCourtListenerText(opinions, record.cluster);
  if (composed.status !== "parsed") {
    return Result.err(
      rejectCourtListenerRecord({
        reason: courtListenerTextRejectionReason(composed),
        sourceRecordKey,
        clusterId,
        opinionIds: opinions.map(({ row }) => row.id),
        diagnostics: [
          {
            path: "opinions",
            detail:
              composed.status === "scope-defect"
                ? `scope defect: ${composed.defect}`
                : composed.status,
          },
        ],
      }),
    );
  }
  const plan = planned.value;
  const classification = classifyCourtListenerDecision({
    opinionTypes: plan.opinions.map(({ type }) => type),
    scdbPresent: plan.scdbPresent,
    principal: composed.principal,
  });
  const { decisionType } = classification;
  return Result.ok({
    sourceDocumentId: plan.sourceDocumentId,
    country: plan.country,
    language: plan.language,
    courtId: plan.courtId,
    court: plan.court,
    caseNumber: plan.caseNumber,
    caseNumberType: plan.caseNumberType,
    identifiers: plan.identifiers,
    decisionDate: plan.decisionDate,
    decisionType,
    sourceUrl: plan.sourceUrl,
    documentUrl: plan.documentUrl,
    judges: plan.judges,
    textFields: {
      headnote: textField(composed.textFields.headnotes),
      abstract: textField(composed.textFields.syllabus),
      summary: textField(composed.textFields.summary),
      legalSentence: absentTextField(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    },
    metadata: checkedDecisionMetadata({
      ...plan.metadata,
      classification,
      textSelection: composed.opinions,
      diagnostics: plan.diagnostics,
    }),
    fulltext: composed.blocks.map(({ plainText }) => plainText).join("\n\n"),
    documentAst: {
      version: 1,
      source: {
        system: COURTLISTENER_IMPORT_KEY,
        documentId: clusterId,
        webUrl: plan.sourceUrl,
        printUrl: plan.sourceUrl,
      },
      metadata: {
        caseNumber: plan.caseNumber,
        ecli: null,
        court: plan.court,
        decisionDate: plan.decisionDate ?? null,
        decisionType,
        keywords: [],
        statutes: [],
      },
      blocks: [...composed.blocks],
    },
    sections: [...composed.sections],
    citationScopes: composed.citationScopes,
    rawHash: plan.rawHash,
    sourceRaw: plan.sourceRaw,
    sourceRawContentType: plan.sourceRawContentType,
    parserVersion: COURTLISTENER_PARSER_VERSION,
  });
};

export const reparseStoredRaw = (
  stored: StoredRawReparseInput,
): StoredRawReparseOutcome => {
  const text = Result.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(stored.raw),
    catch: () => "invalid-utf8",
  });
  if (Result.isError(text)) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.RAW_FIDELITY_LOST,
      detail: "Stored raw is not valid UTF-8",
    };
  }
  const decoded = decodeCourtListenerRaw({
    raw: text.value,
    contentType: stored.contentType ?? "",
  });
  if (Result.isError(decoded)) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.UNSUPPORTED_CONTENT,
      detail: decoded.error.reason,
    };
  }
  const mapped = mapCourtListenerRecord(decoded.value);
  if (Result.isError(mapped)) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
      detail: mapped.error.reason,
    };
  }
  const result = mapped.value;
  if (
    result.sourceDocumentId !== stored.sourceDocumentId ||
    result.language !== stored.language ||
    result.court !== stored.court
  ) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
      detail: "Stored cluster, court or language differs from the raw record",
    };
  }
  return { type: "parsed", result };
};
