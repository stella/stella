import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawIndexJobs,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { redactCaseLawDecision } from "@/api/handlers/case-law/erasure";
import { toSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { ensureCorpusProjectionDesiredStateTx } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * Erasure reaches the corpus index through the projection queue: scrubbing the
 * canonical content moves the decision's desired state to an erase, which the
 * projection worker applies. Nothing else on the decision records where a copy
 * was written, so this transition is the whole guarantee that a redacted
 * decision leaves the index.
 */

const SERVING_GENERATION = "case_law_v6";
const SOURCE_ID = toSafeId<"caseLawSource">(
  "0198e331-e578-7000-8000-0000000002a1",
);
const DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-0000000002a2",
);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  scopedDb = asTestRaw<ScopedDb>(
    async (callback: (tx: typeof db) => Promise<unknown>) =>
      await db.transaction(async (tx) => await callback(asTestRaw(tx))),
  );
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.delete(corpusIndexProjectionStates).where(sql`true`);
  await db.delete(caseLawIndexJobs).where(sql`true`);
  await db.delete(caseLawDecisions).where(sql`true`);
  await db.delete(caseLawSources).where(sql`true`);
  await db.delete(corpusIndexGenerations).where(sql`true`);

  await db.insert(caseLawSources).values({
    id: SOURCE_ID,
    adapterKey: "erasure",
    name: "Erasure",
  });
  await db.insert(caseLawDecisions).values({
    id: DECISION_ID,
    sourceId: SOURCE_ID,
    caseNumber: "4 As 3/2008",
    court: "Nejvyšší správní soud",
    country: "CZE",
    language: "cs",
    fulltext: "Osobní údaj.",
    contentHash: "a".repeat(64),
  });
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation: SERVING_GENERATION,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS[SERVING_GENERATION],
    ),
    status: "serving",
  });
  await db.transaction(async (tx) => {
    await ensureCorpusProjectionDesiredStateTx(
      asTestRaw(tx),
      { family: "case_law", entityId: DECISION_ID },
      SERVING_GENERATION,
    );
  });
});

test("redaction queues the erase the projection worker applies", async () => {
  const before = await db
    .select({ desiredAction: corpusIndexProjectionStates.desiredAction })
    .from(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.entityId, DECISION_ID));
  // Without this the assertion below would pass on a state that was never
  // an upsert to begin with.
  expect(before).toEqual([{ desiredAction: "upsert" }]);

  const outcome = await redactCaseLawDecision({
    decisionId: DECISION_ID,
    scopedDb,
  });

  expect(outcome).toEqual({ type: "redacted" });
  expect(
    await db
      .select({
        desiredAction: corpusIndexProjectionStates.desiredAction,
        desiredFingerprint: corpusIndexProjectionStates.desiredFingerprint,
      })
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, DECISION_ID)),
  ).toEqual([{ desiredAction: "erase", desiredFingerprint: null }]);
  expect(
    await db
      .select({
        contentHash: caseLawDecisions.contentHash,
        fulltext: caseLawDecisions.fulltext,
      })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, DECISION_ID)),
  ).toEqual([{ contentHash: null, fulltext: null }]);
});

test("redaction records one audit row naming no generation", async () => {
  await redactCaseLawDecision({ decisionId: DECISION_ID, scopedDb });

  expect(
    await db
      .select({
        generation: caseLawIndexJobs.generation,
        operation: caseLawIndexJobs.operation,
        status: caseLawIndexJobs.status,
      })
      .from(caseLawIndexJobs)
      .where(eq(caseLawIndexJobs.decisionId, DECISION_ID)),
  ).toEqual([{ generation: null, operation: "redact", status: "succeeded" }]);
});
