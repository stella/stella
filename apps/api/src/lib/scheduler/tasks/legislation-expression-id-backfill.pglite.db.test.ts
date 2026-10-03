import { afterAll } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { registerExpressionBackfillCases } from "@/api/tests/helpers/legislation-expression-id-backfill-cases";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>> | undefined;
afterAll(async () => await client?.close());

registerExpressionBackfillCases({
  engine: "pglite",
  openDatabase: async () => {
    client = await createTestPglite();
    return asTestRaw<GatedTestDb>(drizzle({ client }));
  },
  // PGlite has one session and cannot exercise PostgreSQL advisory locks.
  // The real-engine suite uses the production slot unchanged.
  createRuntime: (options) =>
    createScriptBackfillRuntime({
      ...options,
      slot: { tryAcquire: async () => true, release: () => {} },
    }),
});
