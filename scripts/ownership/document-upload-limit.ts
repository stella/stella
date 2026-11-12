import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "document-upload-limit",
  capability: "The largest stored matter document",
  owner: [
    "packages/api-contract/src/document-version-upload.ts",
    "packages/api-contract/src/limits.ts",
  ],
  summary:
    "`UPLOAD_DOCUMENT_MAX_BYTES` is the one document limit: the presigned " +
    "upload, the browser and CLI preflights, DOCX stamping, OCR, the readers " +
    "of stored files and the desktop Office download all read it (the CLI " +
    "through its generated copy of the module, the desktop app through " +
    "`build.rs`). `MULTIPART_DOCUMENT_MAX_BYTES` derives the smaller bound a " +
    "multipart form through the API may carry from the server's ingress " +
    "ceiling. The API's process-wide document byte budget is sized from it.",
  enforcement: {
    kind: "custom-rule",
    rule: "no-literal-document-byte-limit",
    reason:
      "Reports a numeric literal or product of literals equal to the document limit in `apps/*/src` and `packages/*/src` outside the owner, its generated CLI copy and the listed coincident budgets.",
  },
} as const satisfies OwnershipEntry;
