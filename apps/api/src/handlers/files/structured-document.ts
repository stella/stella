import { STRUCTURED_DOCUMENT_KINDS } from "@stll/api-contract/legal-file-formats";

import { createArchivePreviewEndpoint } from "@/api/handlers/files/archive-preview";
import { readStructuredDocumentPreview } from "@/api/lib/files/archive-preview";

export default createArchivePreviewEndpoint(
  STRUCTURED_DOCUMENT_KINDS,
  readStructuredDocumentPreview,
);
