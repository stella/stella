// parser-output-unchanged: diagnostics and pure helper imports moved to @stll/case-law-ingestion-core; parser output unchanged.
// parser-output-unchanged: shared error output does not change parsed decisions.
import { getIngestionDiagnosticsSink } from "@stll/case-law-ingestion-core/ingestion-diagnostics-sink";
import { sanitizeErrorAttributesForOutput } from "@stll/errors";

const DOCUMENT_PARSE_FAILED_EVENT = "case_law.ingestion.document_parse_failed";

type LogDocumentParseFailureOptions = {
  adapterKey: string;
  caseNumber: string | undefined;
  error: unknown;
};

export const logDocumentParseFailure = ({
  adapterKey,
  caseNumber,
  error,
}: LogDocumentParseFailureOptions): void => {
  const attributes = sanitizeErrorAttributesForOutput({
    adapterKey,
    caseNumber,
    "error.type": error,
  });
  getIngestionDiagnosticsSink().warn(DOCUMENT_PARSE_FAILED_EVENT, attributes);
};
