import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "extracted-content-read",
  capability: "Reading extracted document content",
  owner: ["apps/api/src/lib/document-content-provenance.ts"],
  summary:
    "The document content owner supplies extracted text and OCR payloads with their current source identity. Other modules may select extraction metadata and write extraction results.",
  enforcement: {
    kind: "table-column-read",
    specifiers: ["@/api/db/schema", "@/api/db/schema/templates"],
    table: "extractedContent",
    columns: ["ciphertext", "iv", "ocrPayloadCiphertext", "ocrPayloadIv"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
