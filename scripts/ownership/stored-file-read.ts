import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "stored-file-read",
  capability: "Reading stored file bytes",
  owner: ["apps/api/src/lib/file-scan/stored-file.ts"],
  summary:
    "`readStoredFile` owns stored file reads for request delivery. Named " +
    "processing, maintenance, and transport-test consumers use the raw " +
    "readers for their specific operations.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/s3"],
    names: [
      "getS3ObjectWithSignal",
      "readS3ObjectIfPresent",
      "readS3ObjectBounded",
      "readS3ObjectBoundedIfPresent",
      "readS3ArrayBuffer",
    ],
    allowed: [
      {
        path: "apps/api/src/handlers/case-law/ingestion/pipeline/stored-raw.ts",
        reason: "Loads persisted source bytes for ingestion.",
      },
      {
        path: "apps/api/src/handlers/case-law/ingestion/eu-completion-runner.ts",
        reason:
          "Loads persisted source bytes under the completion job's byte cap and tick deadline.",
      },
      {
        path: "apps/api/src/handlers/case-law/ingestion/background-replay-runner.ts",
        reason:
          "Loads persisted source bytes under the replay tick's byte cap and deadline.",
      },
      {
        path: "apps/api/src/handlers/chat/chat-prompt.ts",
        reason: "Loads document bytes for prompt preparation.",
      },
      {
        path: "apps/api/src/handlers/files/document-properties.ts",
        reason: "Reads office bytes to extract document properties.",
      },
      {
        path: "apps/api/src/handlers/files/update-document-properties.ts",
        reason: "Reads office bytes before updating document properties.",
      },
      {
        path: "apps/api/src/handlers/entities/publish-folio-collab-version.ts",
        reason:
          "Reads a collaboration checkpoint before publishing a document version.",
      },
      {
        path: "apps/api/src/handlers/entities/checkpoint-folio-collab-room.ts",
        reason: "Reads a collaboration snapshot before storing its checkpoint.",
      },
      {
        path: "apps/api/src/handlers/entities/finalize-desktop-edit-session.ts",
        reason:
          "Reads an edit checkpoint before finalizing the document version.",
      },
      {
        path: "apps/api/src/handlers/reports/builtin-templates.ts",
        reason: "Loads stored templates for report rendering.",
      },
      {
        path: "apps/api/src/handlers/uploads/update.ts",
        reason: "Reads the staged upload for processing and verification.",
      },
      {
        path: "apps/api/src/mcp/file-comparison-run.ts",
        reason: "Loads comparison inputs for document processing.",
      },
      {
        path: "apps/api/src/scripts/replay-case-law-source.ts",
        reason: "Loads persisted source bytes for replay.",
      },
      {
        path: "apps/api/src/scripts/case-law-source-backfill.ts",
        reason: "Loads persisted source bytes for backfill.",
      },
      {
        path: "apps/api/scripts/backfill-image-thumbnails.ts",
        reason: "Loads stored image bytes to build missing thumbnails.",
      },
      {
        path: "apps/api/src/lib/folio-collab-rooms.ts",
        reason: "Loads the persisted collaboration room snapshot.",
      },
      {
        path: "apps/api/src/lib/lists/verification/document-text.ts",
        reason: "Extracts stored document text for list verification.",
      },
      {
        path: "apps/api/src/lib/health/readiness.ts",
        reason:
          "Reads the dedicated readiness object to check storage connectivity.",
      },
      {
        path: "apps/api/src/lib/legal-search/raw-source-storage.ts",
        reason: "Loads persisted legal source bytes for processing.",
      },
      {
        path: "apps/api/src/lib/legal-search/case-law-raw-layout.ts",
        reason: "Loads source layout bytes for case-law processing.",
      },
      {
        path: "apps/api/src/lib/workflow/generate-batch.ts",
        reason: "Loads workflow document inputs for generation.",
      },
      {
        path: "apps/api/src/lib/file-scan/stored-object.ts",
        reason: "Loads bounded object bytes for scanning.",
      },
      {
        path: "apps/api/src/lib/file-derivative-queue.ts",
        reason: "Loads source bytes for derivative generation.",
      },
      {
        path: "apps/api/src/lib/files/organization-file-usage.ts",
        reason: "Verifies stored object bytes during usage reconciliation.",
      },
      {
        path: "apps/api/src/lib/bbox/generate-b-boxes-shared.ts",
        reason: "Loads source bytes for bounding-box generation.",
      },
      {
        path: "apps/api/src/lib/files/office-evidence.ts",
        reason: "Loads office bytes to extract stored file evidence.",
      },
      {
        path: "apps/api/src/lib/s3.test.ts",
        reason: "Exercises the object-read transport.",
      },
      {
        path: "apps/api/src/tests/helpers/fake-s3.test.ts",
        reason: "Exercises the stored-object test adapter.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
