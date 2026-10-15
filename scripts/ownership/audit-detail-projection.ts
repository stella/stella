import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "audit-detail-projection",
  capability: "Projecting audit change details for storage and reads",
  owner: ["apps/api/src/lib/audit-log-details.ts"],
  summary:
    "Audit readers share a total resource policy and principal-bound feature projection. The storage projection is confined to the audit writer; pages, exports and tools use the read projection.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/audit-log-details"],
    names: ["auditChangesForResource"],
    allowed: [
      {
        path: "apps/api/src/lib/db/audit-recording.ts",
        reason: "Applies the storage projection when recording audit events.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
