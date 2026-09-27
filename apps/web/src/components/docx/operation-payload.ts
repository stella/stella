import { Result } from "better-result";

import {
  FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION,
  parseFolioDocumentOperationBatch,
} from "@stll/folio-core";
import type { FolioAIEditOperation } from "@stll/folio-react";

/** Validate one opaque persisted operation with Folio's shared contract. */
export const parsePersistedDocxOperation = (
  payload: unknown,
): FolioAIEditOperation | null => {
  const parsed = Result.try(() =>
    parseFolioDocumentOperationBatch({
      version: FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION,
      operations: [payload],
    }),
  );
  if (Result.isError(parsed)) {
    return null;
  }
  return parsed.value.operations.at(0) ?? null;
};
