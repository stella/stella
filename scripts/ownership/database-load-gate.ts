import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "database-load-gate",
  capability: "Gating and sizing heavy database maintenance",
  owner: [
    "packages/db-load-gate/",
    "apps/api/src/lib/db/ebs-balance-reader.ts",
  ],
  summary:
    "One transport-free package combines health signals, records decisions, " +
    "sizes batches and arbitrates a database-wide priority slot. The API " +
    "adapter alone reads both RDS EBS balances through CloudWatch; index " +
    "runners and backfills use the same source and freshness rules.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
