import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "provider-event-records",
  capability: "Minimal verified provider event persistence",
  owner: [
    "apps/api/src/lib/hosted-usage-provider/webhook-store.ts",
    "apps/api/src/handlers/hosted-usage-webhook/replay.ts",
  ],
  summary:
    "The store projects authenticated deliveries through the dispatch schema before persistence. Retention redacts completed details while preserving deduplication identifiers and unresolved records.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/schema", "@/api/db/schema/usage"],
    names: ["hostedUsageWebhookEvents"],
    allowed: [
      {
        path: "apps/api/src/tests/pglite-test-db.ts",
        reason:
          "Schema export or full-schema test introspection; no production receipt writer.",
      },
      {
        path: "apps/api/src/tests/security/test-utils.ts",
        reason:
          "Schema export or full-schema test introspection; no production receipt writer.",
      },
      {
        path: "apps/api/src/tests/pglite-role-grants.test.ts",
        reason:
          "Schema export or full-schema test introspection; no production receipt writer.",
      },
      {
        path: "apps/api/src/lib/account-deletion-coverage.test.ts",
        reason:
          "Schema export or full-schema test introspection; no production receipt writer.",
      },
      {
        path: "apps/api/src/lib/workspace-deletion-coverage.test.ts",
        reason:
          "Schema export or full-schema test introspection; no production receipt writer.",
      },
      {
        path: "apps/api/src/lib/workflow/straggler-catchup.db.test.ts",
        reason:
          "Schema export or full-schema test introspection; no production receipt writer.",
      },
      {
        path: "apps/api/src/lib/entity-filters.differential.test.ts",
        reason:
          "Schema export or full-schema test introspection; no production receipt writer.",
      },
      {
        path: "apps/api/src/handlers/hosted-usage-webhook/receive.test.ts",
        reason: "Asserts the persisted delivery projection.",
      },
      {
        path: "apps/api/src/handlers/hosted-usage-webhook/contract.postgres.test.ts",
        reason: "Asserts dispatch and receipt outcomes in PostgreSQL.",
      },
      {
        path: "apps/api/src/lib/hosted-usage-provider/replay.postgres.test.ts",
        reason:
          "Asserts selected receipt replay and durable audit outcomes in PostgreSQL.",
      },
      {
        path: "apps/api/src/lib/hosted-usage-provider/webhook-retention.postgres.test.ts",
        reason: "Asserts retention against isolated PostgreSQL receipts.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
