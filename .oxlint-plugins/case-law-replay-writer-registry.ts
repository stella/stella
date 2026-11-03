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
    line: 716,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/citation-resolution.ts",
    line: 1034,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/citation-resolution.ts",
    line: 1276,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/citation-resolution.ts",
    line: 1355,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/citation-resolution.ts",
    line: 1448,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/citation-resolution.ts",
    line: 1494,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/citation-resolution.ts",
    line: 1534,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/citation-resolution.ts",
    line: 1569,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/citation-resolution.ts",
    line: 1619,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/erasure.ts",
    line: 443,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/erasure.ts",
    line: 752,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/erasure.ts",
    line: 762,
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
    line: 85,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/pipeline/decision-existing.ts",
    line: 207,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/pipeline/decision-existing.ts",
    line: 263,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/pipeline/decision-identity.ts",
    line: 474,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/pipeline/decision-identity.ts",
    line: 735,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/pipeline/decision-row-context.ts",
    line: 184,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/pipeline/decision-row-update.ts",
    line: 449,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/pipeline/decision-row.ts",
    line: 262,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/pipeline/decision-row.ts",
    line: 309,
    kind: "pending",
  },
  {
    file: "apps/api/src/handlers/case-law/ingestion/pipeline/decision-row.ts",
    line: 327,
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
    line: 370,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/db/transitions.ts",
    line: 404,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/db/transitions.ts",
    line: 554,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/db/transitions.ts",
    line: 645,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/db/transitions.ts",
    line: 1220,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/db/transitions.ts",
    line: 1756,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/db/transitions.ts",
    line: 1830,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/db/transitions.ts",
    line: 1867,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/db/transitions.ts",
    line: 1915,
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
    line: 202,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/legal-search/corpus-index-generation-store.ts",
    line: 331,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/legal-search/corpus-index-generation-store.ts",
    line: 340,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/legal-search/corpus-index-generation-store.ts",
    line: 407,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/legal-search/sk-document-backfill.ts",
    line: 1131,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/legal-search/sk-document-backfill.ts",
    line: 1309,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/legal-search/sk-document-backfill.ts",
    line: 1422,
    kind: "pending",
  },
  {
    file: "apps/api/src/lib/legal-search/sk-document-backfill.ts",
    line: 1502,
    kind: "pending",
  },
] as const satisfies readonly ReplayWriterOwner[];
