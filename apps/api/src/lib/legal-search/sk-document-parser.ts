// parser-output-unchanged: the deferred parser is shared with stored-object replay without changing its output.
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import type { EmptyAst } from "@/api/lib/legal-search/document-types";
import { sanitizeResult } from "@/api/lib/legal-search/ingestion-normalization";
import { parseSkDecisionPdf } from "@/api/lib/legal-search/parsers/sk-courts";
import { segmentDecision } from "@/api/lib/legal-search/segment-decision";
import type { PendingDocument } from "@/api/lib/legal-search/sk-document-backfill";

export type BackfilledDocument = {
  fulltext: string;
  documentAst: DocumentAst | EmptyAst;
  sections: ReturnType<typeof segmentDecision>;
};

/**
 * Parse one decision's PDF into the same shape ingestion would have
 * produced. Runs the bytes through `sanitizeResult` so a backfilled
 * row is byte-for-byte what the pipeline would have written, rather
 * than a second normalization that drifts from it.
 */
export const parsePendingDocument = async (
  pending: Pick<
    PendingDocument,
    "caseNumber" | "ecli" | "court" | "decisionDate" | "decisionType"
  >,
  pdfBytes: Uint8Array,
): Promise<BackfilledDocument | undefined> => {
  const parsed = await parseSkDecisionPdf({
    pdfBytes,
    caseNumber: pending.caseNumber,
    ecli: pending.ecli ?? undefined,
    court: pending.court,
    decisionDate: pending.decisionDate ?? undefined,
    decisionType: pending.decisionType ?? undefined,
  });

  if (parsed.documentAst.blocks.length === 0 || parsed.fulltext === "") {
    return undefined;
  }

  const sanitized = sanitizeResult({
    caseNumber: pending.caseNumber,
    court: pending.court,
    country: "SVK",
    language: "sk",
    metadata: {},
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    rawHash: "",
    fulltext: parsed.fulltext,
    documentAst: parsed.documentAst,
  });

  const fulltext = sanitized.fulltext ?? "";
  // Text remains readable even when the reader rejects its structure.
  if (fulltext === "") {
    return undefined;
  }

  return {
    fulltext,
    documentAst: sanitized.documentAst,
    sections: segmentDecision(fulltext),
  };
};
