import { folioDocumentOperationBatchSchema } from "@stll/folio-agents";
import type { FolioAIEditOperation } from "@stll/folio-core/ai-edits";
import { FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION } from "@stll/folio-core/server";

/** Parse suggestion operations once at the API boundary and return folio's
 * canonical output, rather than retaining the untrusted input objects. */
export const validateDocxSuggestionOperations = (
  operations: readonly unknown[],
): readonly FolioAIEditOperation[] | undefined => {
  const validation = folioDocumentOperationBatchSchema["~standard"].validate({
    version: FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION,
    operations,
  });
  return validation.issues === undefined
    ? validation.value.operations
    : undefined;
};
