import {
  FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION,
  parseFolioDocumentOperationBatch,
} from "@stll/folio-core";
import type { FolioAIEditOperation } from "@stll/folio-react";

/** Validate one opaque persisted operation with Folio's shared contract. */
export const parsePersistedDocxOperation = (
  payload: unknown,
): FolioAIEditOperation | null => {
  try {
    const parsed = parseFolioDocumentOperationBatch({
      version: FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION,
      operations: [payload],
    });
    return parsed.operations.at(0) ?? null;
  } catch {
    return null;
  }
};
