import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "audited-download-grant",
  capability: "Granting a user a signed URL to stored file content",
  owner: ["apps/api/src/lib/audited-download.ts"],
  summary:
    "A signed URL hands the caller the stored bytes, whether the browser " +
    "saves them or renders them inline. `auditedPresignDownload` records a " +
    "download or an access in the caller's transaction before it signs, so a grant " +
    "and its audit row commit together. The bare signer stays with modules " +
    "that sign an object whose access an audited operation already recorded.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/s3-presign"],
    names: ["presignDownloadUrl"],
    allowed: [
      {
        path: "apps/api/src/handlers/reports/exports/get.ts",
        reason:
          "Signs the result of the requester's own report export, audited when the export runs.",
      },
      {
        path: "apps/api/src/lib/entity-versions/desktop-edit-session-utils.ts",
        reason:
          "Signs the working copy of a desktop edit session or collaboration room, audited when it opens.",
      },
      {
        path: "apps/api/src/lib/uploads/file-comparison/deliver-redline.ts",
        reason:
          "Signs a temporary redline produced by an audited comparison run.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
