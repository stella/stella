import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "database-load-gate",
  capability: "Gating and sizing heavy database maintenance",
  owner: [
    "packages/db-load-gate/",
    "apps/api/src/lib/db/ebs-balance-reader.ts",
    "apps/api/src/lib/db/pressure-reader.ts",
  ],
  summary:
    "One transport-free package combines health signals, records decisions, " +
    "sizes batches and arbitrates a database-wide priority slot. The API " +
    "adapters read RDS EBS balances and host pressure through read-only AWS APIs, " +
    "with fleet-wide cached host readings. PostgreSQL supplies aggregate session " +
    "and replication pressure; index runners, backfills and scheduler admission " +
    "share thresholds, freshness and pacing decisions.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
