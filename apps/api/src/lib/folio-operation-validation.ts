/**
 * The one parse a persisted Folio suggestion operation goes through.
 *
 * Shared rather than per-slice: the suggestions endpoint takes ops from a
 * client and the review engine derives them from a finding's delta, and both
 * reach the same column. A second, looser parse on either path would persist a
 * row that crashes every later reader of the entity.
 */

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
