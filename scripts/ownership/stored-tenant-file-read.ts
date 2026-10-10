import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "stored-tenant-file-read",
  capability: "Reading tenant-scoped stored file bytes",
  owner: ["apps/api/src/lib/file-scan/stored-file.ts"],
  summary:
    "`readStoredFile` owns stored file reads for request delivery. Named " +
    "processing, maintenance, and transport-test consumers use the raw " +
    "readers for their specific operations.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/s3-presign"],
    names: ["readTenantS3ArrayBuffer"],
    allowed: [
      {
        path: "apps/api/src/handlers/contacts/extract-procuracao.ts",
        reason: "Loads an authorized document for contact extraction.",
      },
      {
        path: "apps/api/src/lib/document-processing-queue.ts",
        reason: "Loads tenant-scoped source bytes for document processing.",
      },
      {
        path: "apps/api/src/lib/ocr-local/recognize-local.ts",
        reason: "Loads tenant-scoped source bytes for local recognition.",
      },
      {
        path: "apps/api/src/lib/s3-presign.test.ts",
        reason: "Exercises tenant-scoped object reads.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
