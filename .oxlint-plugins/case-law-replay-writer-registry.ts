export type ReplayWriterOwner = {
  file: string;
  line: number;
} & (
  | { kind: "pending" }
  | { kind: "transition"; invariant: { file: string; test: string } }
);

export const REPLAY_WRITER_REGISTRY = [
  {
    file: "apps/api/src/db/root.ts",
    line: 787,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/citation-resolution.ts",
    line: 1037,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/citation-resolution.ts",
    line: 1369,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/citation-resolution.ts",
    line: 1448,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/citation-resolution.ts",
    line: 1541,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/citation-resolution.ts",
    line: 1587,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/citation-resolution.ts",
    line: 1626,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/citation-resolution.ts",
    line: 1661,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/citation-resolution.ts",
    line: 1711,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/erasure.ts",
    line: 444,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/erasure.ts",
    line: 757,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/erasure.ts",
    line: 767,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
    line: 490,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
    line: 646,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
    line: 815,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
    line: 835,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
    line: 951,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
    line: 1180,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
    line: 1266,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
    line: 1301,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
    line: 1330,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
    line: 1357,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
    line: 1470,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
    line: 1617,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
    line: 1638,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
    line: 1670,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
    line: 1873,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
    line: 1897,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
    line: 1936,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
    line: 1962,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
    line: 1988,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
    line: 2009,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
    line: 2077,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
    line: 2188,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/pipeline/citations.ts",
    line: 235,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/pipeline/corpus-mirror.ts",
    line: 88,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/pipeline/decision-identity.ts",
    line: 710,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/pipeline/decision-identity.ts",
    line: 981,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/pipeline/decision-row-context.ts",
    line: 188,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/pipeline/decision-row-update.ts",
    line: 506,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/pipeline/decision-row.ts",
    line: 383,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/pipeline/decision-row.ts",
    line: 449,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/pipeline/decision-row.ts",
    line: 467,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/pipeline/source-observation.ts",
    line: 44,
    kind: "transition",
    invariant: {
      file: "apps/api/src/lib/case-law/replay-write-contracts.postgres.test.ts",
      test: "source observation allocation always advances a stored counter",
    },
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/pipeline/unread-items.ts",
    line: 235,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/supplement-erasure.ts",
    line: 156,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/polarity/rule-engine.ts",
    line: 422,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/billing/invoice-send-revocation.ts",
    line: 58,
    kind: "transition",
    invariant: {
      file: "apps/api/src/handlers/invoice-links/invoice-links.integration.test.ts",
      test: "a revoked link opens nothing, and revoking keeps the first revocation",
    },
  },
  {
    file: "apps/api/src/lib/case-law/provision-state-backfill/backfill.ts",
    line: 152,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/corpus-ingestion-checkpoint.ts",
    line: 112,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/corpus-ingestion-checkpoint.ts",
    line: 154,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/corpus-ingestion-checkpoint.ts",
    line: 187,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/db/partner-client-operator.ts",
    line: 78,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/db/service-client-operator.ts",
    line: 137,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/db/service-client-operator.ts",
    line: 162,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/db/transitions.ts",
    line: 377,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/db/transitions.ts",
    line: 411,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/db/transitions.ts",
    line: 561,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/db/transitions.ts",
    line: 652,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/db/transitions.ts",
    line: 1283,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/db/transitions.ts",
    line: 1855,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/db/transitions.ts",
    line: 1929,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/db/transitions.ts",
    line: 1966,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/db/transitions.ts",
    line: 2014,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/legal-search/case-law-search-index.ts",
    line: 176,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/legal-search/case-law-search-index.ts",
    line: 356,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/legal-search/case-law-search-index.ts",
    line: 392,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/legal-search/case-law-source-ingestion-lease.ts",
    line: 59,
    kind: "transition",
    invariant: {
      file: "apps/api/src/lib/case-law/replay-write-contracts.postgres.test.ts",
      test: "lease acquisition and release change selected ownership",
    },
  },
  {
    file: "apps/api/src/lib/legal-search/case-law-source-ingestion-lease.ts",
    line: 96,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/legal-search/case-law-source-ingestion-lease.ts",
    line: 136,
    kind: "transition",
    invariant: {
      file: "apps/api/src/lib/case-law/replay-write-contracts.postgres.test.ts",
      test: "lease acquisition and release change selected ownership",
    },
  },
  {
    file: "apps/api/src/lib/legal-search/corpus-index-generation-store.ts",
    line: 304,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/legal-search/corpus-index-generation-store.ts",
    line: 313,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/legal-search/corpus-index-generation-store.ts",
    line: 380,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/legal-search/corpus-index-generation-store.ts",
    line: 490,
    kind: "transition",
    invariant: {
      file: "apps/api/src/lib/legal-search/corpus-index-generation-retire.db.test.ts",
      test: "retire moves a building generation to retired with its receipt, and from that commit no writer projects it",
    },
  },
] as const satisfies readonly ReplayWriterOwner[];
