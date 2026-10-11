import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "audit-detail-read",
  capability: "Reading persisted audit changes",
  owner: ["apps/api/src/lib/audit-log-details.ts"],
  summary:
    "The audit detail owner supplies caller-aware change selections and projections. Direct column access and implicit full-row reads stay inside this owner; database assertions remain in test files excluded from the production ownership rule.",
  enforcement: {
    kind: "table-column-read",
    specifiers: ["@/api/db/schema", "@/api/db/schema/contacts"],
    table: "auditLogs",
    columns: ["changes"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
