import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "scheduler-lease-write",
  capability: "Claiming and releasing a scheduler job lease",
  owner: ["apps/api/src/lib/scheduler/runner.ts"],
  summary:
    "A job lease is its token, claim time and expiry. The runner claims, renews and releases it as one, and its token guards every write a lease holder makes.",
  enforcement: {
    kind: "table-column-write",
    specifiers: ["@/api/db/schema", "@/api/db/schema/contacts"],
    table: "schedulerJobs",
    columns: ["lockedBy", "lockedAt", "lockedUntil"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
