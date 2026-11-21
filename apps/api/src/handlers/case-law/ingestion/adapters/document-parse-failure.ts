// parser-output-unchanged: shared error output does not change parsed decisions.
import { sanitizeErrorAttributesForOutput } from "@stll/errors";

import { logger } from "@/api/lib/observability/logger";

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
  logger.warn(DOCUMENT_PARSE_FAILED_EVENT, attributes);
};
