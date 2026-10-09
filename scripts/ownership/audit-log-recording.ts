import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "audit-log-recording",
  capability: "Environment-free audit event recording",
  owner: ["apps/api/src/lib/db/audit-recording.ts"],
  summary:
    "One insertion owner applies audit projection and provenance; the HTTP wrapper binds request metadata while background operations require no API environment.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/db/audit-recording"],
    names: ["recordAuditGroups", "createBackgroundAuditRecorder"],
    allowed: [
      {
        path: "apps/api/src/lib/audit-log.ts",
        reason:
          "Binds HTTP request metadata and exposes the shared recorder contract.",
      },
      {
        path: "apps/api/src/lib/auth/legal-resolve-audit.ts",
        reason:
          "Records the verified resolve principal without request payloads.",
      },
      {
        path: "apps/api/src/lib/db/service-client-audit.ts",
        reason: "Records transactional operator lifecycle events.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
