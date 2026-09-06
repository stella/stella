import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import { corpusIndexGenerations } from "@/api/db/schema";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { CORPUS_PROJECTION_APPEND_COMMIT_MODE } from "@/api/lib/legal-search/corpus-index-projection-engine";
import { executeCorpusProjectionAppendCycle } from "@/api/lib/legal-search/corpus-index-projection-executor";
import { CORPUS_PROJECTION_GENERATION_SCOPE } from "@/api/lib/legal-search/corpus-index-projection-scope";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const TARGET = {
  family: "case_law",
  generation: "case_law_v5",
} as const;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const runInTransaction = async <TResult>(
  operation: (tx: Transaction) => Promise<TResult>,
): Promise<TResult> =>
  await db.transaction(
    async (tx) => await operation(asTestRaw<Transaction>(tx)),
  );

const unusedIngest = async () =>
  panic("An idle projection cycle must not reach the engine");

const runCycle = async (
  commitMode: (typeof CORPUS_PROJECTION_APPEND_COMMIT_MODE)[keyof typeof CORPUS_PROJECTION_APPEND_COMMIT_MODE],
) =>
  await executeCorpusProjectionAppendCycle({
    runInTransaction,
    client: {
      ingestCommittedBatch: unusedIngest,
      ingestQueuedBatch: unusedIngest,
    },
    commitMode,
    family: TARGET.family,
    generation: TARGET.generation,
    scope: CORPUS_PROJECTION_GENERATION_SCOPE,
    limit: 8,
    leaseMs: 60_000,
    payloadReadConcurrency: 4,
    retryDelayMs: 5000,
    payloadRetryLimit: 3,
  });

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(corpusIndexGenerations).values({
    ...TARGET,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS.case_law_v5,
    ),
    status: "building",
  });
});

afterAll(async () => {
  await client.close();
});

test("every cycle reports one timing per phase, in both commit modes", async () => {
  for (const commitMode of Object.values(
    CORPUS_PROJECTION_APPEND_COMMIT_MODE,
  )) {
    const result = await runCycle(commitMode);

    expect(result.status).toBe("idle");
    expect(result.requestCount).toBe(0);
    // The caller logs these, so a phase that stops being measured has to
    // fail here rather than quietly report zero forever.
    expect(result.timing).toEqual({
      reservationMs: expect.any(Number),
      materialReadMs: 0,
      payloadLoadMs: 0,
      ingestMs: 0,
      storeCommitMs: 0,
    });
    expect(result.timing.reservationMs).toBeGreaterThanOrEqual(0);
  }
});
