import { panic } from "better-result";

import { FOLIO_DOCUMENT_OPERATION_JSON_SCHEMA } from "@stll/folio-agents";

export const getFolioDocumentOperationJsonSchemaVariants = () => {
  const variants = FOLIO_DOCUMENT_OPERATION_JSON_SCHEMA.oneOf;
  if (variants === undefined) {
    panic("Folio document operation schema is missing its `oneOf` variants");
  }

  return variants;
};
