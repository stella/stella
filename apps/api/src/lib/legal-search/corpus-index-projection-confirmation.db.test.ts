import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { toSafeId, type SafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_INGEST_TIMEOUT_MS,
  CorpusIndexError,
} from "@/api/lib/legal-search/corpus-index-client";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { recoverExpiredCorpusProjectionIntentsTx } from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import { confirmCorpusProjectionAppends } from "@/api/lib/legal-search/corpus-index-projection-confirmation";
import { deriveCorpusIndexProjectionDescriptor } from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import { legislationProjectionInputFromCanonical } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  corpusIndexAcceptedAppendConfirmationWindowMs,
  corpusIndexAppendPublishDelayMs,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import { executeCorpusProjectionAppendCycle } from "@/api/lib/legal-search/corpus-index-projection-executor";
import { CORPUS_PROJECTION_LEASE_MAX_MS } from "@/api/lib/legal-search/corpus-index-projection-store";
import { EFFECTIVE_CONSOLIDATION } from "@/api/lib/legal-search/legislation-expression-classification";
import { logger } from "@/api/lib/observability/logger";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const TARGET = {
  family: "legislation",
  generation: "legislation_v2",
} as const;
const MANIFEST = CORPUS_INDEX_MANIFESTS.legislation_v2;
const SOURCE_ID = "0198e331-e578-7000-8000-0000000000d1";
const EPOCH = 3n;
const LEASE_MS = 5 * 60_000;
// Later than any row timestamp the database writes on its own, so seeded
// states are already runnable at the start of the test clock.
const T0 = new Date("2030-01-01T00:00:00.000Z");
const documentId = (index: number): string =>
  `0198e331-e578-7000-8000-0000000005${String(index).padStart(2, "0")}`;
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

/**
 * Every projection statement reads `clock_timestamp()`; this resolves it to a
 * test clock, so leases, acceptance, and confirmation windows move only when
 * the test moves them.
 */
const setClock = async (now: Date): Promise<void> => {
  await db.execute(
    sql.raw(`
      CREATE OR REPLACE FUNCTION public.clock_timestamp()
      RETURNS timestamptz
      LANGUAGE sql
      VOLATILE
      AS $$ SELECT '${now.toISOString()}'::timestamptz $$
    `),
  );
};

const runInTransaction = async <TResult>(
  operation: (tx: Transaction) => Promise<TResult>,
): Promise<TResult> =>
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL search_path = public, pg_catalog`);
    return await operation(asTestRaw<Transaction>(tx));
  });

/**
 * An index node that accepts appends into a queue and publishes them only
 * when told to, however long that takes. Every acceptance is recorded, so a
 * duplicate append is visible as a second acceptance of the same revision.
 */
const slowEngine = () => {
  const queued = new Map<string, number>();
  const published = new Map<string, number>();
  const acceptances: string[] = [];
  let census: "answering" | "unavailable" = "answering";
  const accept = (ndjson: string) => {
    const revisions = new Set<string>();
    for (const line of ndjson.split("\n")) {
      const { projection_revision } = JSON.parse(line);
      if (typeof projection_revision !== "string") {
        panic("Appended document has no revision");
      }
      revisions.add(projection_revision);
      queued.set(
        projection_revision,
        (queued.get(projection_revision) ?? 0) + 1,
      );
    }
    acceptances.push(...revisions);
  };
  return {
    acceptances,
    published,
    accept,
    publish: () => {
      for (const [revision, count] of queued) {
        published.set(revision, (published.get(revision) ?? 0) + count);
      }
      queued.clear();
    },
    setCensus: (next: "answering" | "unavailable") => {
      census = next;
    },
    client: {
      aggregate: async ({ query }: { query: string }) => {
        if (census === "unavailable") {
          return Result.err(
            new CorpusIndexError({
              message: "search unavailable",
              status: 503,
              reach: "unreachable",
            }),
          );
        }
        return Result.ok({
          projection_revisions: {
            buckets: Array.from(published, ([key, doc_count]) => ({
              key,
              doc_count,
            })).filter(({ key }) => query.includes(`"${key}"`)),
            doc_count_error_upper_bound: 0,
            sum_other_doc_count: 0,
          },
        });
      },
    },
  };
};

type SlowEngine = ReturnType<typeof slowEngine>;

const seedLegislation = async (indexes: readonly number[]) => {
  const rows = indexes.map((index) => ({
    id: toSafeId<"legislationDocument">(documentId(index)),
    sourceId: toSafeId<"legislationSource">(SOURCE_ID),
    eli: `eli/cz/sb/2016/${100 + index}`,
    title: `Act ${100 + index}`,
    country: "CZE",
    language: "cs",
    documentType: "act",
    status: "current",
    effectiveDate: "2016-01-01",
    versionValidFrom: "2016-01-01",
    versionValidTo: null,
    contentHash: "b".repeat(64),
    textS3Key: `test-corpus/${index}`,
    projectionEpoch: EPOCH,
  }));
  await db.insert(legislationDocuments).values(rows);
  await db.insert(corpusIndexProjectionStates).values(
    rows.map((row) => {
      const descriptor = deriveCorpusIndexProjectionDescriptor(
        MANIFEST,
        legislationProjectionInputFromCanonical({
          documentId: row.id,
          sourceId: row.sourceId,
          jurisdiction: row.country,
          language: row.language,
          documentType: row.documentType,
          contentHash: row.contentHash,
          title: row.title,
          status: row.status,
          effectiveDate: row.effectiveDate,
          versionValidFrom: row.versionValidFrom,
          versionValidTo: row.versionValidTo,
          eli: row.eli,
          sourceDescriptor: null,
          ...EFFECTIVE_CONSOLIDATION,
        }),
      );
      if (descriptor.action !== "upsert") {
        return panic("Seeded legislation row is not projectable");
      }
      return {
        ...TARGET,
        entityId: String(row.id),
        desiredAction: "upsert" as const,
        desiredEpoch: EPOCH,
        desiredFingerprint: descriptor.fingerprint,
        desiredIndexId: descriptor.indexId,
      };
    }),
  );
  return rows.map(({ id }) => id);
};

type AppendOutcome = "accepted" | "timed_out_after_accepting" | "refused";

const timeoutError = () => {
  const aborted = new Error("The operation timed out.");
  aborted.name = "TimeoutError";
  return new CorpusIndexError({
    message: `ingest failed within its ${CORPUS_INDEX_INGEST_TIMEOUT_MS}ms budget`,
    cause: aborted,
    reach: "unreachable",
  });
};

const appendCycle = async ({
  engine,
  entityIds,
  outcome = "accepted",
}: {
  engine: SlowEngine;
  entityIds: readonly SafeId<"legislationDocument">[];
  outcome?: AppendOutcome;
}) =>
  await executeCorpusProjectionAppendCycle({
    runInTransaction,
    client: {
      ingestQueuedBatch: async (_indexId, ndjson) => {
        switch (outcome) {
          case "accepted":
            engine.accept(ndjson);
            return Result.ok(undefined);
          case "timed_out_after_accepting":
            engine.accept(ndjson);
            return Result.err(timeoutError());
          case "refused":
            return Result.err(
              new CorpusIndexError({
                message: "connection refused",
                cause: new Error("connect ECONNREFUSED"),
                reach: "unreachable",
              }),
            );
          default:
            outcome satisfies never;
            return panic(`Unhandled append outcome: ${String(outcome)}`);
        }
      },
    },
    ...TARGET,
    scope: { type: "subjects", entityIds },
    limit: entityIds.length,
    leaseMs: LEASE_MS,
    payloadReadConcurrency: 2,
    retryDelayMs: 5000,
    payloadRetryLimit: 3,
    payloadReader: async () => ({ text: "An act.", ast: null }),
  });

const confirm = async (
  engine: SlowEngine,
  entityIds: readonly SafeId<"legislationDocument">[],
) =>
  await confirmCorpusProjectionAppends({
    runInTransaction,
    client: engine.client,
    ...TARGET,
    scope: { type: "subjects", entityIds },
    limit: 128,
  });

const intents = async (entityIds: readonly string[]) =>
  await db
    .select()
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        eq(corpusIndexProjectionIntents.generation, TARGET.generation),
        inArray(corpusIndexProjectionIntents.entityId, [...entityIds]),
      ),
    )
    .orderBy(corpusIndexProjectionIntents.entityId);

const states = async (entityIds: readonly string[]) =>
  await db
    .select()
    .from(corpusIndexProjectionStates)
    .where(
      and(
        eq(corpusIndexProjectionStates.generation, TARGET.generation),
        inArray(corpusIndexProjectionStates.entityId, [...entityIds]),
      ),
    )
    .orderBy(corpusIndexProjectionStates.entityId);

/**
 * The invariant the confirmation pass exists for: an applied revision is
 * searchable in full, and nothing was appended twice.
 */
const expectAppliedOnlyWhenSearchable = async (
  engine: SlowEngine,
  entityIds: readonly string[],
) => {
  for (const intent of await intents(entityIds)) {
    if (intent.status === "applied") {
      expect(engine.published.get(intent.id)).toBe(
        intent.expectedDocumentCount ?? panic("Applied intent has no count"),
      );
    }
  }
  expect(new Set(engine.acceptances).size).toBe(engine.acceptances.length);
};

const expectConverged = async (entityIds: readonly string[]) => {
  for (const state of await states(entityIds)) {
    expect({
      action: state.appliedAction,
      epoch: state.appliedEpoch,
      fingerprint: state.appliedFingerprint,
      indexId: state.appliedIndexId,
    }).toEqual({
      action: state.desiredAction,
      epoch: state.desiredEpoch,
      fingerprint: state.desiredFingerprint,
      indexId: state.desiredIndexId,
    });
  }
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(corpusIndexGenerations).values({
    ...TARGET,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(MANIFEST),
    status: "building",
  });
  await db.insert(legislationSources).values({
    id: toSafeId<"legislationSource">(SOURCE_ID),
    adapterKey: "projection-confirmation-test",
    name: "Projection confirmation test",
    descriptor: null,
  });
});

afterAll(async () => {
  await client.close();
});

test("a node that publishes after every client budget and append lease still converges once", async () => {
  const engine = slowEngine();
  const entityIds = await seedLegislation([1, 2, 3]);
  await setClock(T0);

  const appended = await appendCycle({ engine, entityIds });
  expect(appended).toMatchObject({ status: "completed", accepted: 3 });
  expect(engine.acceptances).toHaveLength(3);

  // Well past the ingest budget and the longest append lease the store grants,
  // and inside the confirmation window: the node has published nothing yet.
  const lateMs = Math.max(
    CORPUS_INDEX_INGEST_TIMEOUT_MS,
    CORPUS_PROJECTION_LEASE_MAX_MS,
  );
  for (const offsetMs of [lateMs / 2, lateMs + 60_000, 2 * lateMs]) {
    await setClock(at(offsetMs));
    await runInTransaction(
      async (tx) =>
        await recoverExpiredCorpusProjectionIntentsTx(tx, {
          ...TARGET,
          limit: 128,
        }),
    );
    expect(await appendCycle({ engine, entityIds })).toMatchObject({
      status: "idle",
    });
    expect(await confirm(engine, entityIds)).toMatchObject({
      status: "completed",
      applied: 0,
      awaitingPublication: 3,
      unpublishedCleanupPending: 0,
    });
    await expectAppliedOnlyWhenSearchable(engine, entityIds);
  }
  expect((await intents(entityIds)).map(({ status }) => status)).toEqual([
    "append_committed",
    "append_committed",
    "append_committed",
  ]);
  expect(engine.acceptances).toHaveLength(3);

  engine.publish();
  await setClock(at(2 * lateMs + 1000));
  expect(await confirm(engine, entityIds)).toMatchObject({
    status: "completed",
    applied: 3,
    awaitingPublication: 0,
  });
  await expectAppliedOnlyWhenSearchable(engine, entityIds);
  await expectConverged(entityIds);

  // Idempotent: a repeat finds nothing to do, and no cycle appends again.
  expect(await confirm(engine, entityIds)).toMatchObject({ status: "idle" });
  expect(await appendCycle({ engine, entityIds })).toMatchObject({
    status: "idle",
  });
  expect(engine.acceptances).toHaveLength(3);
});

test("an acceptance that timed out after the engine took it is applied once, never resent", async () => {
  const engine = slowEngine();
  const entityIds = await seedLegislation([11, 12]);
  await setClock(T0);

  const appended = await appendCycle({
    engine,
    entityIds,
    outcome: "timed_out_after_accepting",
  });
  expect(appended.status).toBe("append_unknown");
  expect(appended.cycleRetryDelayMs).toBeNull();
  expect(appended.accepted).toBe(2);
  expect(appended.unknownCleanupPending).toBe(0);
  expect((await intents(entityIds)).map(({ status }) => status)).toEqual([
    "append_committed",
    "append_committed",
  ]);

  await setClock(at(CORPUS_PROJECTION_LEASE_MAX_MS + 60_000));
  expect(await appendCycle({ engine, entityIds })).toMatchObject({
    status: "idle",
  });
  engine.publish();
  expect(await confirm(engine, entityIds)).toMatchObject({ applied: 2 });
  expect(engine.acceptances).toHaveLength(2);
  await expectAppliedOnlyWhenSearchable(engine, entityIds);
  await expectConverged(entityIds);
});

test("a refused connection is an outage: nothing accepted, revisions cleaned up, the cycle backs off", async () => {
  const engine = slowEngine();
  const entityIds = await seedLegislation([21]);
  await setClock(T0);

  const appended = await appendCycle({
    engine,
    entityIds,
    outcome: "refused",
  });
  expect(appended.status).toBe("engine_unavailable");
  expect(appended.cycleRetryDelayMs).toBeGreaterThan(0);
  expect(appended.accepted).toBe(0);
  expect(appended.unknownCleanupPending).toBe(1);
  expect((await intents(entityIds)).map(({ status }) => status)).toEqual([
    "cleanup_pending",
  ]);
  expect((await states(entityIds)).at(0)?.failureAttempts).toBe(0);
});

test("a census outage abandons nothing, even past the confirmation window", async () => {
  const engine = slowEngine();
  const entityIds = await seedLegislation([31]);
  await setClock(T0);
  expect(await appendCycle({ engine, entityIds })).toMatchObject({
    accepted: 1,
  });

  engine.setCensus("unavailable");
  await setClock(
    at(corpusIndexAcceptedAppendConfirmationWindowMs(MANIFEST) + 60_000),
  );
  const first = await confirm(engine, entityIds);
  expect(first).toMatchObject({
    status: "engine_unavailable",
    applied: 0,
    unpublishedCleanupPending: 0,
  });
  expect(first.cycleRetryDelayMs).toBeGreaterThan(0);
  expect(await confirm(engine, entityIds)).toMatchObject({
    status: "engine_unavailable",
  });
  expect((await intents(entityIds)).map(({ status }) => status)).toEqual([
    "append_committed",
  ]);

  engine.setCensus("answering");
  engine.publish();
  expect(await confirm(engine, entityIds)).toMatchObject({ applied: 1 });
  await expectConverged(entityIds);
});

test("an accepted append never published is abandoned through exact cleanup after its window", async () => {
  const engine = slowEngine();
  const entityIds = await seedLegislation([41]);
  await setClock(T0);
  expect(await appendCycle({ engine, entityIds })).toMatchObject({
    accepted: 1,
  });
  const accepted =
    (await intents(entityIds)).at(0) ?? panic("Missing accepted intent");
  const acceptedAt =
    accepted.appendCommittedAt ?? panic("Accepted intent has no acceptance");
  const windowMs = corpusIndexAcceptedAppendConfirmationWindowMs(MANIFEST);

  await setClock(new Date(acceptedAt.getTime() + windowMs - 1000));
  expect(await confirm(engine, entityIds)).toMatchObject({
    awaitingPublication: 1,
    unpublishedCleanupPending: 0,
  });

  const warn = spyOn(logger, "warn");
  try {
    const overdueAt = new Date(acceptedAt.getTime() + windowMs);
    await setClock(overdueAt);
    expect(await confirm(engine, entityIds)).toMatchObject({
      status: "completed",
      applied: 0,
      unpublishedCleanupPending: 1,
    });
    expect(warn).toHaveBeenCalledWith(
      "corpus_projection.append_unpublished",
      expect.objectContaining({
        revision: accepted.id,
        reason: "overdue",
        expectedDocuments: accepted.expectedDocumentCount,
        observedDocuments: 0,
      }),
    );
    const [abandoned] = await intents(entityIds);
    expect(abandoned?.status).toBe("cleanup_pending");
    // The delete waits out the engine's own commit window measured from the
    // recorded acceptance, so it cannot run ahead of a late publication.
    expect(abandoned?.appendPublishBarrierAt).toEqual(
      new Date(
        acceptedAt.getTime() + corpusIndexAppendPublishDelayMs(MANIFEST),
      ),
    );
    expect(abandoned?.cleanupNotBefore).toEqual(overdueAt);
    const [state] = await states(entityIds);
    expect(state).toMatchObject({
      appliedAction: null,
      workStatus: "retry_scheduled",
      failureAttempts: 1,
      lastFailureKind: "append_unknown",
    });
  } finally {
    warn.mockRestore();
  }

  // Publishing now is too late to apply: the census sees no accepted intent.
  engine.publish();
  expect(await confirm(engine, entityIds)).toMatchObject({ status: "idle" });
  await expectAppliedOnlyWhenSearchable(engine, entityIds);
});

test("a census that counts more documents than were appended never applies the revision", async () => {
  const engine = slowEngine();
  const entityIds = await seedLegislation([51]);
  await setClock(T0);
  expect(await appendCycle({ engine, entityIds })).toMatchObject({
    accepted: 1,
  });
  const revision =
    (await intents(entityIds)).at(0)?.id ?? panic("Missing accepted intent");
  engine.publish();
  engine.published.set(revision, (engine.published.get(revision) ?? 0) + 1);

  expect(await confirm(engine, entityIds)).toMatchObject({
    applied: 0,
    unpublishedCleanupPending: 1,
  });
  expect((await intents(entityIds)).map(({ status }) => status)).toEqual([
    "cleanup_pending",
  ]);
  expect((await states(entityIds)).at(0)?.appliedAction).toBeNull();
});
