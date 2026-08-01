import { afterAll, beforeAll, expect, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api-postgres";
import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as authSchema from "@/api/db/auth-schema";
import * as rlsExports from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import * as schema from "@/api/db/schema";
import {
  caseLawCorpusIndexBackfills,
  caseLawCorpusIndexProjections,
  caseLawCorpusIndexSourceReconciliations,
  caseLawCorpusIndexWriterLeases,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import {
  acquireCaseLawCorpusGenerationLease,
  backfillCorpusIndex,
  caseLawCorpusIndexAdapter,
  createCaseLawGenerationBackfill,
  generationProjectionTargetIds,
} from "@/api/handlers/case-law/corpus-index";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { ConcurrentModificationError } from "@/api/lib/errors/tagged-errors";
import {
  caseLawCorpusProjectionJoin,
  currentCaseLawCorpusProjection,
} from "@/api/lib/legal-search/case-law-corpus-projection";
import { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import {
  createSchemaPglite,
  installPgliteSchemaPrerequisites,
} from "@/api/tests/pglite-schema";

const allSchema = { ...schema, ...authSchema, ...rlsExports };
const CREATED_AT = new Date("2026-07-30T12:00:00.000Z");
const GENERATION = "case_law_v2";
const noRemoteEffectCompensation = async (): Promise<void> => {
  await Promise.resolve();
};

const publicSourceId = toSafeId<"caseLawSource">(
  "00000000-0000-4000-8000-000000000001",
);
const restrictedSourceId = toSafeId<"caseLawSource">(
  "00000000-0000-4000-8000-000000000002",
);
const publicFirstId = toSafeId<"caseLawDecision">(
  "00000000-0000-4000-8000-000000000011",
);
const restrictedId = toSafeId<"caseLawDecision">(
  "00000000-0000-4000-8000-000000000012",
);
const noContentId = toSafeId<"caseLawDecision">(
  "00000000-0000-4000-8000-000000000013",
);
const publicLastId = toSafeId<"caseLawDecision">(
  "00000000-0000-4000-8000-000000000014",
);

let client: Awaited<ReturnType<typeof createSchemaPglite>> | undefined;
let db: ReturnType<typeof drizzle>;

beforeAll(
  async () => {
    client = await createSchemaPglite();
    db = drizzle({ client });
    await db.execute(sql.raw("CREATE ROLE stella NOLOGIN"));
    await db.execute(sql.raw("CREATE ROLE stella_ingestion NOLOGIN"));
    await installPgliteSchemaPrerequisites(db);
    const { sqlStatements } = await pushSchema(allSchema, db);
    for (const statement of sqlStatements) {
      // oxlint-disable-next-line no-await-in-loop -- DDL statements must apply in emitted order (deterministic test schema setup)
      await db.execute(sql.raw(statement));
    }

    await db.insert(caseLawSources).values([
      { adapterKey: "public", id: publicSourceId, name: "public" },
      {
        adapterKey: "restricted",
        descriptor: {
          allowsDerivedAi: false,
          allowsRedistribution: false,
          attribution: null,
          license: "restricted",
        },
        id: restrictedSourceId,
        name: "restricted",
      },
    ]);

    const decision = {
      court: "Test court",
      country: "CZE",
      decisionDate: "2026-01-01",
      fulltext: "text",
      language: "cs",
    };
    await db.insert(caseLawDecisions).values([
      {
        ...decision,
        caseNumber: "1 T 1/2026",
        contentHash: "first",
        createdAt: CREATED_AT,
        id: publicFirstId,
        languageGroupKey: "first",
        slug: "first",
        sourceId: publicSourceId,
      },
      {
        ...decision,
        caseNumber: "2 T 2/2026",
        contentHash: "restricted",
        createdAt: CREATED_AT,
        id: restrictedId,
        languageGroupKey: "restricted",
        slug: "restricted",
        sourceId: restrictedSourceId,
      },
      {
        ...decision,
        caseNumber: "3 T 3/2026",
        createdAt: CREATED_AT,
        id: noContentId,
        languageGroupKey: "missing",
        slug: "missing",
        sourceId: publicSourceId,
      },
      {
        ...decision,
        caseNumber: "4 T 4/2026",
        contentHash: "last",
        createdAt: CREATED_AT,
        id: publicLastId,
        languageGroupKey: "last",
        slug: "last",
        sourceId: publicSourceId,
      },
    ]);
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client?.close();
});

const scopedDb = async <T>(callback: (tx: Transaction) => Promise<T>) =>
  await db.transaction(async (tx) => {
    // SAFETY: PGlite's transaction provides the Drizzle query surface the
    // runner uses; the explicit transaction is required for LOCK TABLE.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    const transaction = tx as unknown as Transaction;
    return await callback(transaction);
  });

const readCheckpoint = async (generation: string) =>
  (
    await db
      .select()
      .from(caseLawCorpusIndexBackfills)
      .where(eq(caseLawCorpusIndexBackfills.generation, generation))
      .limit(1)
  ).at(0);

const nextBackfillSnapshotAt = async (): Promise<Date> => {
  const snapshot = (
    await db
      .select({
        value: sql<Date>`coalesce(max(${caseLawCorpusIndexBackfills.snapshotAt}), clock_timestamp()) + interval '1 second'`,
      })
      .from(caseLawCorpusIndexBackfills)
  ).at(0)?.value;
  if (!snapshot) {
    throw new Error("expected database backfill snapshot");
  }
  return snapshot;
};

const ignoreProjectionRemoval = async () => {
  await Promise.resolve();
};

const completeRemoteEffect = async (): Promise<void> => {
  await Promise.resolve();
};

const queueSourceReconciliation = async (
  generation: string,
  sourceId: SafeId<"caseLawSource">,
): Promise<void> => {
  const boundary = (
    await db
      .select({
        createdAt: caseLawDecisions.createdAt,
        id: caseLawDecisions.id,
      })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.sourceId, sourceId))
      .orderBy(desc(caseLawDecisions.createdAt), desc(caseLawDecisions.id))
      .limit(1)
  ).at(0);
  await db
    .insert(caseLawCorpusIndexSourceReconciliations)
    .values({
      generation,
      sourceId,
      upperCreatedAt: boundary?.createdAt ?? null,
      upperId: boundary?.id ?? null,
    })
    .onConflictDoUpdate({
      target: [
        caseLawCorpusIndexSourceReconciliations.generation,
        caseLawCorpusIndexSourceReconciliations.sourceId,
      ],
      set: {
        cursorCreatedAt: null,
        cursorId: null,
        revision: sql`${caseLawCorpusIndexSourceReconciliations.revision} + 1`,
        upperCreatedAt: boundary?.createdAt ?? null,
        upperId: boundary?.id ?? null,
      },
    });
};

test(
  "one generation writer excludes rebuilds until it releases",
  async () => {
    const generation = "case_law_v20";
    let lease = 0;
    const first = await acquireCaseLawCorpusGenerationLease({
      generation,
      newLeaseToken: () =>
        `00000000-0000-4000-8000-${String(++lease).padStart(12, "0")}`,
      scopedDb,
    });
    expect(first).not.toBeNull();

    let backfillCalls = 0;
    const backfill = createCaseLawGenerationBackfill({
      backfillRows: async () => {
        backfillCalls += 1;
        return 0;
      },
      newLeaseToken: () =>
        `00000000-0000-4000-8000-${String(++lease).padStart(12, "0")}`,
      removeProjection: ignoreProjectionRemoval,
    });
    expect(await backfill(scopedDb, 10, generation)).toEqual({
      indexed: 0,
      status: "busy",
    });
    expect(await backfillCorpusIndex(scopedDb, 10, generation)).toEqual({
      indexed: 0,
      status: "busy",
    });
    expect(backfillCalls).toBe(0);

    await first?.release();
    const reclaimed = await acquireCaseLawCorpusGenerationLease({
      generation,
      newLeaseToken: () =>
        `00000000-0000-4000-8000-${String(++lease).padStart(12, "0")}`,
      scopedDb,
    });
    expect(reclaimed).not.toBeNull();
    await reclaimed?.release();

    const writerState = (
      await db
        .select()
        .from(caseLawCorpusIndexWriterLeases)
        .where(eq(caseLawCorpusIndexWriterLeases.generation, generation))
    ).at(0);
    expect(writerState).toMatchObject({
      leaseExpiresAt: null,
      leaseToken: null,
    });
  },
  { timeout: 30_000 },
);

test("generation lease releases its transaction before a remote effect", async () => {
  let databaseCallbackActive = false;
  const trackedScopedDb = async <T>(
    callback: (tx: Transaction) => Promise<T>,
  ) =>
    await scopedDb(async (tx) => {
      databaseCallbackActive = true;
      try {
        return await callback(tx);
      } finally {
        databaseCallbackActive = false;
      }
    });
  const lease = await acquireCaseLawCorpusGenerationLease({
    generation: "case_law_v21",
    scopedDb: trackedScopedDb,
  });
  expect(lease).not.toBeNull();
  if (lease === null) {
    return;
  }

  await lease.beforeRemoteEffect({
    effect: async () => {
      expect(databaseCallbackActive).toBe(false);
      const contender = await acquireCaseLawCorpusGenerationLease({
        generation: "case_law_v21",
        scopedDb,
      });
      expect(contender).toBeNull();
    },
    onLeaseLost: noRemoteEffectCompensation,
  });

  await lease.release();
});

test(
  "generation precedence is immutable when a serving checkpoint is created late",
  async () => {
    const rebuildGeneration = "case_law_v23";
    const servingGeneration = "case_law_v22";
    await db.insert(caseLawCorpusIndexBackfills).values([
      {
        generation: rebuildGeneration,
        snapshotAt: new Date("2026-07-31T00:00:00.000Z"),
      },
      {
        generation: servingGeneration,
        snapshotAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    ]);
    let writes = 0;
    const backfill = createCaseLawGenerationBackfill({
      backfillRows: async (_runnerDb, rows, _generation, options) => {
        await options.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: noRemoteEffectCompensation,
        });
        writes += 1;
        return rows.length;
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000060",
      removeProjection: ignoreProjectionRemoval,
    });

    try {
      expect(await backfill(scopedDb, 1, rebuildGeneration)).toEqual({
        indexed: 1,
        status: "advanced",
      });
      expect(writes).toBe(1);
    } finally {
      await db
        .delete(caseLawCorpusIndexBackfills)
        .where(
          sql`${caseLawCorpusIndexBackfills.generation} IN (${rebuildGeneration}, ${servingGeneration})`,
        );
    }
  },
  { timeout: 30_000 },
);

test("rejects an invalid generation before creating durable state", async () => {
  const generation = "invalid generation";
  const backfill = createCaseLawGenerationBackfill({
    backfillRows: async () => 0,
    newLeaseToken: () => "00000000-0000-4000-8000-000000000099",
    removeProjection: ignoreProjectionRemoval,
  });

  const rejection: unknown = await backfill(scopedDb, 1, generation).then(
    () => null,
    (error: unknown) => error,
  );

  expect(rejection).toBeInstanceOf(CorpusIndexError);
  expect(
    await db
      .select()
      .from(caseLawCorpusIndexWriterLeases)
      .where(eq(caseLawCorpusIndexWriterLeases.generation, generation)),
  ).toHaveLength(0);
  expect(
    await db
      .select()
      .from(caseLawCorpusIndexBackfills)
      .where(eq(caseLawCorpusIndexBackfills.generation, generation)),
  ).toHaveLength(0);
});

test(
  "replays the snapshot once and reconciles pending rows after completion",
  async () => {
    const sent: SafeId<"caseLawDecision">[][] = [];
    let guardedPages = 0;
    let lease = 0;
    const backfill = createCaseLawGenerationBackfill({
      backfillRows: async (runnerDb, rows, rebuildGeneration, options) => {
        await options.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: noRemoteEffectCompensation,
        });
        sent.push(rows.map((row) => row.id));
        guardedPages += 1;
        await runnerDb(async (tx) => {
          await options.beforeDatabaseMark(tx);
          await tx
            .delete(caseLawCorpusIndexProjections)
            .where(
              eq(caseLawCorpusIndexProjections.generation, rebuildGeneration),
            );
        });
        return rows.length;
      },
      newLeaseToken: () =>
        `00000000-0000-4000-8000-${String(++lease).padStart(12, "0")}`,
      removeProjection: ignoreProjectionRemoval,
    });

    expect(await backfill(scopedDb, 2, GENERATION)).toMatchObject({
      indexed: 1,
      status: "advanced",
    });
    expect(await backfill(scopedDb, 2, GENERATION)).toMatchObject({
      indexed: 1,
      status: "advanced",
    });
    await db.insert(caseLawCorpusIndexProjections).values({
      decisionId: publicFirstId,
      generation: GENERATION,
      pendingAction: "index",
      pendingHash: "first",
      pendingIndexIds: [corpusIndexId(GENERATION, "CZE")],
    });
    expect(await backfill(scopedDb, 2, GENERATION)).toEqual({
      indexed: 1,
      status: "advanced",
    });
    expect(await backfill(scopedDb, 2, GENERATION)).toEqual({
      indexed: 0,
      status: "complete",
    });
    expect(await backfill(scopedDb, 2, GENERATION)).toEqual({
      indexed: 0,
      status: "complete",
    });

    // Same-timestamp rows are visited in UUID order, exactly once. Restricted
    // and incomplete records advance the keyset cursor as terminal skips but
    // never cross the index boundary.
    expect(sent).toEqual([[publicFirstId], [publicLastId], [publicFirstId]]);
    expect(guardedPages).toBe(3);
    const checkpoint = await readCheckpoint(GENERATION);
    expect(checkpoint).toMatchObject({
      cursorCreatedAt: CREATED_AT,
      cursorId: publicLastId,
      leaseExpiresAt: null,
      leaseToken: null,
      status: "complete",
    });
  },
  { timeout: 30_000 },
);

test(
  "initial snapshots remove every legacy-only target before advancing",
  async () => {
    const generation = "case_law_v24";
    const legacyIndexId = corpusIndexId(generation, "CZE");
    await db
      .update(caseLawDecisions)
      .set({ indexedGeneration: legacyIndexId })
      .where(sql`${caseLawDecisions.id} IN (${restrictedId}, ${noContentId})`);
    const removed = new Map<SafeId<"caseLawDecision">, string[]>();
    const backfill = createCaseLawGenerationBackfill({
      backfillRows: async (_runnerDb, rows, _generation, options) => {
        await options.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: noRemoteEffectCompensation,
        });
        return rows.length;
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000070",
      removeProjection: async (
        _runnerDb,
        { generation: rebuildGeneration, options, row },
      ) => {
        await options.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: noRemoteEffectCompensation,
        });
        removed.set(row.id, [
          ...generationProjectionTargetIds({
            generation: rebuildGeneration,
            row,
          }),
        ]);
      },
    });

    try {
      expect(await backfill(scopedDb, 10, generation)).toEqual({
        indexed: 2,
        status: "advanced",
      });
      expect(removed).toEqual(
        new Map([
          [restrictedId, [legacyIndexId]],
          [noContentId, [legacyIndexId]],
        ]),
      );
      expect(await readCheckpoint(generation)).toMatchObject({
        cursorId: publicLastId,
        status: "running",
      });
    } finally {
      await db
        .update(caseLawDecisions)
        .set({ indexedGeneration: null })
        .where(
          sql`${caseLawDecisions.id} IN (${restrictedId}, ${noContentId})`,
        );
      await db
        .delete(caseLawCorpusIndexBackfills)
        .where(eq(caseLawCorpusIndexBackfills.generation, generation));
    }
  },
  { timeout: 30_000 },
);

test(
  "reconciles each generation even when the serving generation marks the hash current",
  async () => {
    const generation = "case_law_v25";
    const newerGeneration = "case_law_v26";
    try {
      await db.insert(caseLawCorpusIndexBackfills).values({
        generation,
        snapshotAt: await nextBackfillSnapshotAt(),
        status: "complete",
      });
      await db.insert(caseLawCorpusIndexBackfills).values({
        generation: newerGeneration,
        snapshotAt: await nextBackfillSnapshotAt(),
        status: "running",
      });
      await db.insert(caseLawCorpusIndexProjections).values({
        decisionId: publicFirstId,
        generation,
        pendingAction: "index",
        pendingHash: "first",
        pendingIndexIds: [corpusIndexId(generation, "CZE")],
      });
      await db
        .update(caseLawDecisions)
        .set({
          indexedGeneration: corpusIndexId("case_law_v1", "CZE"),
          indexedHash: "first",
        })
        .where(eq(caseLawDecisions.id, publicFirstId));

      const backfill = createCaseLawGenerationBackfill({
        backfillRows: async (runnerDb, rows, rebuildGeneration, options) => {
          await options.beforeRemoteEffect({
            effect: completeRemoteEffect,
            onLeaseLost: noRemoteEffectCompensation,
          });
          const row = rows.at(0);
          if (!row) {
            return 0;
          }
          let indexed = 0;
          await runnerDb(async (tx) => {
            await options.beforeDatabaseMark(tx);
            const marked = await caseLawCorpusIndexAdapter.markIndexedBatch(
              tx,
              {
                indexId: corpusIndexId(rebuildGeneration, row.country),
                mode: {
                  generation: rebuildGeneration,
                  type: "generation-rebuild",
                },
                now: new Date("2026-07-31T13:00:00.000Z"),
                rows,
              },
            );
            indexed = marked.size;
          });
          return indexed;
        },
        newLeaseToken: () => "00000000-0000-4000-8000-000000000050",
        removeProjection: ignoreProjectionRemoval,
      });

      expect(await backfill(scopedDb, 10, generation)).toEqual({
        indexed: 1,
        status: "advanced",
      });
      const projection = (
        await db
          .select()
          .from(caseLawCorpusIndexProjections)
          .where(eq(caseLawCorpusIndexProjections.generation, generation))
          .limit(1)
      ).at(0);
      expect(projection).toMatchObject({
        indexId: corpusIndexId(generation, "CZE"),
        indexedHash: "first",
        pendingAction: null,
        pendingHash: null,
        pendingIndexIds: [],
      });
      const decision = (
        await db
          .select({
            indexedGeneration: caseLawDecisions.indexedGeneration,
            indexedHash: caseLawDecisions.indexedHash,
          })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.id, publicFirstId))
          .limit(1)
      ).at(0);
      expect(decision).toEqual({
        indexedGeneration: corpusIndexId("case_law_v1", "CZE"),
        indexedHash: "first",
      });

      // A prior eligibility delete can remove the remote copy, then lose its
      // database CAS and leave this projection looking current. The new
      // eligible revision must replace it anyway.
      await db.insert(caseLawCorpusIndexProjections).values({
        decisionId: restrictedId,
        generation,
        indexId: corpusIndexId(generation, "CZE"),
        indexedHash: "restricted",
      });
      await db
        .update(caseLawDecisions)
        .set({ country: "SVK" })
        .where(eq(caseLawDecisions.id, publicFirstId));
      await db
        .update(caseLawCorpusIndexProjections)
        .set({
          pendingAction: "index",
          pendingHash: "first",
          pendingIndexIds: [corpusIndexId(generation, "SVK")],
        })
        .where(eq(caseLawCorpusIndexProjections.generation, generation));
      expect(await backfill(scopedDb, 10, generation)).toEqual({
        indexed: 1,
        status: "advanced",
      });
      expect(await readCheckpoint(generation)).toMatchObject({
        status: "complete",
      });
      const movedProjection = (
        await db
          .select({ indexId: caseLawCorpusIndexProjections.indexId })
          .from(caseLawCorpusIndexProjections)
          .where(eq(caseLawCorpusIndexProjections.generation, generation))
          .limit(1)
      ).at(0);
      expect(movedProjection?.indexId).toBe(corpusIndexId(generation, "SVK"));
    } finally {
      await db
        .update(caseLawDecisions)
        .set({ country: "CZE" })
        .where(eq(caseLawDecisions.id, publicFirstId));
      await db
        .delete(caseLawCorpusIndexBackfills)
        .where(eq(caseLawCorpusIndexBackfills.generation, generation));
      await db
        .delete(caseLawCorpusIndexBackfills)
        .where(eq(caseLawCorpusIndexBackfills.generation, newerGeneration));
    }
  },
  { timeout: 30_000 },
);

test(
  "retains the snapshot lease while the first reconciliation is in flight",
  async () => {
    const generation = "case_law_v27";
    let invocation = 0;
    let reconciliationStarted: (() => void) | undefined;
    let releaseReconciliation: (() => void) | undefined;
    const reconciliationStartedPromise = new Promise<void>((resolve) => {
      reconciliationStarted = resolve;
    });
    const releaseReconciliationPromise = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    let lease = 60;
    const backfill = createCaseLawGenerationBackfill({
      backfillRows: async (runnerDb, rows, rebuildGeneration, options) => {
        invocation += 1;
        await options.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: noRemoteEffectCompensation,
        });
        if (invocation === 2) {
          reconciliationStarted?.();
          await releaseReconciliationPromise;
          await runnerDb(async (tx) => {
            await options.beforeDatabaseMark(tx);
            await tx
              .delete(caseLawCorpusIndexProjections)
              .where(
                eq(caseLawCorpusIndexProjections.generation, rebuildGeneration),
              );
          });
        }
        return rows.length;
      },
      newLeaseToken: () =>
        `00000000-0000-4000-8000-${String(++lease).padStart(12, "0")}`,
      removeProjection: ignoreProjectionRemoval,
    });

    expect(await backfill(scopedDb, 100, generation)).toMatchObject({
      status: "advanced",
    });
    await db.insert(caseLawCorpusIndexProjections).values({
      decisionId: publicFirstId,
      generation,
      pendingAction: "index",
      pendingHash: "first",
      pendingIndexIds: [corpusIndexId(generation, "CZE")],
    });
    const completing = backfill(scopedDb, 100, generation);
    await reconciliationStartedPromise;
    expect(await readCheckpoint(generation)).toMatchObject({
      status: "complete",
    });
    expect((await readCheckpoint(generation))?.leaseToken).not.toBeNull();
    expect(await backfill(scopedDb, 100, generation)).toEqual({
      indexed: 0,
      status: "busy",
    });
    releaseReconciliation?.();
    expect(await completing).toEqual({ indexed: 1, status: "advanced" });
    expect(await readCheckpoint(generation)).toMatchObject({
      leaseExpiresAt: null,
      leaseToken: null,
      status: "complete",
    });
  },
  { timeout: 30_000 },
);

test(
  "retains and drains the exact generation target after content is removed",
  async () => {
    const generation = "case_law_v28";
    const indexId = corpusIndexId(generation, "CZE");
    await db.insert(caseLawCorpusIndexBackfills).values({
      generation,
      snapshotAt: await nextBackfillSnapshotAt(),
      status: "complete",
    });
    await db.insert(caseLawCorpusIndexProjections).values({
      decisionId: publicFirstId,
      generation,
      indexedHash: "first",
      indexId,
      pendingAction: "delete",
    });
    await db
      .update(caseLawDecisions)
      .set({ contentHash: null, indexedHash: null })
      .where(eq(caseLawDecisions.id, publicFirstId));

    const removed: string[] = [];
    const backfill = createCaseLawGenerationBackfill({
      backfillRows: async () => {
        throw new Error("delete tombstones must not enter the index path");
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000080",
      removeProjection: async (runnerDb, { options, row }) => {
        await options.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: noRemoteEffectCompensation,
        });
        if (row.generationIndexId !== null) {
          removed.push(row.generationIndexId);
        }
        await runnerDb(async (tx) => {
          await options.beforeDatabaseMark(tx);
          await tx
            .delete(caseLawCorpusIndexProjections)
            .where(eq(caseLawCorpusIndexProjections.generation, generation));
        });
      },
    });

    try {
      expect(await backfill(scopedDb, 10, generation)).toEqual({
        indexed: 0,
        status: "advanced",
      });
      expect(removed).toEqual([indexId]);
      expect(
        await db
          .select()
          .from(caseLawCorpusIndexProjections)
          .where(eq(caseLawCorpusIndexProjections.generation, generation)),
      ).toHaveLength(0);
    } finally {
      await db
        .update(caseLawDecisions)
        .set({ contentHash: "first", indexedHash: "first" })
        .where(eq(caseLawDecisions.id, publicFirstId));
      await db
        .delete(caseLawCorpusIndexBackfills)
        .where(eq(caseLawCorpusIndexBackfills.generation, generation));
    }
  },
  { timeout: 30_000 },
);

test(
  "clears an index action whose content was erased before reconciliation",
  async () => {
    const generation = "case_law_v29";
    await db.insert(caseLawCorpusIndexBackfills).values({
      generation,
      snapshotAt: await nextBackfillSnapshotAt(),
      status: "complete",
    });
    await db.insert(caseLawCorpusIndexProjections).values({
      decisionId: publicFirstId,
      generation,
      pendingAction: "index",
      pendingHash: "first",
      pendingIndexIds: [corpusIndexId(generation, "CZE")],
    });
    await db
      .update(caseLawDecisions)
      .set({ contentHash: null, indexedHash: null })
      .where(eq(caseLawDecisions.id, publicFirstId));
    const backfill = createCaseLawGenerationBackfill({
      backfillRows: async () => {
        throw new Error("erased content must not enter the index path");
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000081",
      removeProjection: async (runnerDb, { options }) => {
        await options.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: noRemoteEffectCompensation,
        });
        await runnerDb(async (tx) => {
          await options.beforeDatabaseMark(tx);
          await tx
            .delete(caseLawCorpusIndexProjections)
            .where(eq(caseLawCorpusIndexProjections.generation, generation));
        });
      },
    });

    try {
      expect(await backfill(scopedDb, 10, generation)).toEqual({
        indexed: 0,
        status: "advanced",
      });
      expect(await backfill(scopedDb, 10, generation)).toEqual({
        indexed: 0,
        status: "complete",
      });
    } finally {
      await db
        .update(caseLawDecisions)
        .set({ contentHash: "first", indexedHash: "first" })
        .where(eq(caseLawDecisions.id, publicFirstId));
      await db
        .delete(caseLawCorpusIndexBackfills)
        .where(eq(caseLawCorpusIndexBackfills.generation, generation));
    }
  },
  { timeout: 30_000 },
);

test(
  "holds the full cursor on failure and lets only one runner own external index writes",
  async () => {
    const retryGeneration = "case_law_v30";
    let releaseFirstPage: (() => void) | undefined;
    let firstPageStarted: (() => void) | undefined;
    const firstPageStartedPromise = new Promise<void>((resolve) => {
      firstPageStarted = resolve;
    });
    const firstPageReleasePromise = new Promise<void>((resolve) => {
      releaseFirstPage = resolve;
    });
    const backfill = createCaseLawGenerationBackfill({
      backfillRows: async (_scopedDb, _rows, _generation, options) => {
        await options.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: noRemoteEffectCompensation,
        });
        firstPageStarted?.();
        await firstPageReleasePromise;
        throw new Error("search unavailable");
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000100",
      removeProjection: ignoreProjectionRemoval,
    });

    const first = backfill(scopedDb, 1, retryGeneration);
    await firstPageStartedPromise;
    expect(await backfill(scopedDb, 1, retryGeneration)).toEqual({
      indexed: 0,
      status: "busy",
    });
    releaseFirstPage?.();
    // Bun's matcher type declares `.rejects.toThrow` as void; capture the
    // rejection explicitly so type-aware lint and the runtime agree.
    const rejection: unknown = await first.then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).toMatchObject({ message: "search unavailable" });

    const failed = await readCheckpoint(retryGeneration);
    expect(failed).toMatchObject({
      cursorCreatedAt: null,
      cursorId: null,
      leaseExpiresAt: null,
      leaseToken: null,
      status: "running",
    });

    const incomplete = createCaseLawGenerationBackfill({
      backfillRows: async (_scopedDb, _rows, _generation, options) => {
        await options.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: noRemoteEffectCompensation,
        });
        return 0;
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000101",
      removeProjection: ignoreProjectionRemoval,
    });
    const incompleteRejection: unknown = await incomplete(
      scopedDb,
      1,
      retryGeneration,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(incompleteRejection).toMatchObject({
      message: "generation backfill page did not reach a fixed point",
    });
    expect(await readCheckpoint(retryGeneration)).toMatchObject({
      cursorCreatedAt: null,
      cursorId: null,
      leaseExpiresAt: null,
      leaseToken: null,
      status: "running",
    });

    const replayed: SafeId<"caseLawDecision">[][] = [];
    const retry = createCaseLawGenerationBackfill({
      backfillRows: async (_scopedDb, rows, _generation, options) => {
        await options.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: noRemoteEffectCompensation,
        });
        replayed.push(rows.map((row) => row.id));
        return rows.length;
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000102",
      removeProjection: ignoreProjectionRemoval,
    });
    expect(await retry(scopedDb, 1, retryGeneration)).toMatchObject({
      indexed: 1,
      status: "advanced",
    });
    expect(replayed).toEqual([[publicFirstId]]);
  },
  { timeout: 30_000 },
);

test(
  "an expired owner cannot issue another remote write after a new owner advances",
  async () => {
    const generation = "case_law_v31";
    let winningRemoteEffects = 0;
    const winner = createCaseLawGenerationBackfill({
      backfillRows: async (_scopedDb, rows, _generation, options) => {
        await options.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: noRemoteEffectCompensation,
        });
        winningRemoteEffects += 1;
        return rows.length;
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000201",
      removeProjection: ignoreProjectionRemoval,
    });

    let staleRemoteEffects = 0;
    let winnerResult: Awaited<ReturnType<typeof winner>> | undefined;
    const stale = createCaseLawGenerationBackfill({
      backfillRows: async (_scopedDb, rows, _generation, options) => {
        await db
          .update(caseLawCorpusIndexBackfills)
          .set({ leaseExpiresAt: new Date("2000-01-01T00:00:00.000Z") })
          .where(eq(caseLawCorpusIndexBackfills.generation, generation));
        await db
          .update(caseLawCorpusIndexWriterLeases)
          .set({ leaseExpiresAt: new Date("2000-01-01T00:00:00.000Z") })
          .where(eq(caseLawCorpusIndexWriterLeases.generation, generation));
        winnerResult = await winner(scopedDb, 1, generation);
        await options.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: noRemoteEffectCompensation,
        });
        staleRemoteEffects += 1;
        return rows.length;
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000200",
      removeProjection: ignoreProjectionRemoval,
    });

    const rejection: unknown = await stale(scopedDb, 1, generation).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(ConcurrentModificationError);
    expect(winnerResult).toMatchObject({ indexed: 1, status: "advanced" });
    expect(winningRemoteEffects).toBe(1);
    expect(staleRemoteEffects).toBe(0);
    expect(await readCheckpoint(generation)).toMatchObject({
      cursorCreatedAt: CREATED_AT,
      cursorId: publicFirstId,
      leaseExpiresAt: null,
      leaseToken: null,
      status: "running",
    });
  },
  { timeout: 30_000 },
);

test(
  "a remote effect that outlives its lease cannot expose a successful result",
  async () => {
    const generation = "case_law_v32";
    const staleDecisionId = toSafeId<"caseLawDecision">(
      "00000000-0000-4000-8000-000000000010",
    );
    const staleIndexId = corpusIndexId(generation, "CZE");
    const successorIndexId = corpusIndexId(generation, "SVK");
    await db.insert(caseLawDecisions).values({
      caseNumber: "stale fence",
      contentHash: "stale",
      country: "CZE",
      court: "Test court",
      createdAt: CREATED_AT,
      decisionDate: "2026-01-01",
      fulltext: "stale text",
      id: staleDecisionId,
      language: "cs",
      languageGroupKey: "stale-fence",
      slug: "stale-fence",
      sourceId: publicSourceId,
    });
    let winningRemoteEffects = 0;
    const winner = createCaseLawGenerationBackfill({
      backfillRows: async (runnerDb, rows, _generation, options) => {
        await options.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: async () =>
            await options.recoverRemoteEffectLeaseLoss({
              entityIds: rows.map(({ id }) => id),
              indexId: successorIndexId,
            }),
        });
        winningRemoteEffects += 1;
        await runnerDb(async (tx) => {
          await options.beforeDatabaseMark(tx);
          await tx
            .update(caseLawCorpusIndexProjections)
            .set({
              indexId: successorIndexId,
              indexedHash: "stale",
              pendingAction: null,
              pendingHash: null,
              pendingIndexIds: [],
            })
            .where(
              and(
                eq(caseLawCorpusIndexProjections.generation, generation),
                eq(caseLawCorpusIndexProjections.decisionId, staleDecisionId),
              ),
            );
        });
        return rows.length;
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000401",
      removeProjection: ignoreProjectionRemoval,
    });

    let staleDatabaseMarks = 0;
    let staleRemoteEffects = 0;
    let winnerResult: Awaited<ReturnType<typeof winner>> | undefined;
    const stale = createCaseLawGenerationBackfill({
      backfillRows: async (runnerDb, rows, _generation, options) => {
        await runnerDb(async (tx) => {
          await options.beforeDatabaseMark(tx);
          await tx.insert(caseLawCorpusIndexProjections).values({
            decisionId: staleDecisionId,
            generation,
            pendingAction: "index",
            pendingHash: "stale",
            pendingIndexIds: [staleIndexId],
          });
        });
        await options.beforeRemoteEffect({
          effect: async () => {
            staleRemoteEffects += 1;
            await db
              .update(caseLawCorpusIndexBackfills)
              .set({ leaseExpiresAt: new Date("2000-01-01T00:00:00.000Z") })
              .where(eq(caseLawCorpusIndexBackfills.generation, generation));
            await db
              .update(caseLawCorpusIndexWriterLeases)
              .set({ leaseExpiresAt: new Date("2000-01-01T00:00:00.000Z") })
              .where(eq(caseLawCorpusIndexWriterLeases.generation, generation));
            await db
              .update(caseLawDecisions)
              .set({ country: "SVK", indexedHash: null })
              .where(eq(caseLawDecisions.id, staleDecisionId));
            winnerResult = await winner(scopedDb, 1, generation);
          },
          onLeaseLost: async () =>
            await options.recoverRemoteEffectLeaseLoss({
              entityIds: rows.map(({ id }) => id),
              indexId: staleIndexId,
            }),
        });
        await runnerDb(options.beforeDatabaseMark);
        staleDatabaseMarks += 1;
        return rows.length;
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000400",
      removeProjection: ignoreProjectionRemoval,
    });

    const rejection: unknown = await stale(scopedDb, 1, generation).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(ConcurrentModificationError);
    expect(winnerResult).toMatchObject({ indexed: 1, status: "advanced" });
    expect(winningRemoteEffects).toBe(1);
    expect(staleRemoteEffects).toBe(1);
    expect(staleDatabaseMarks).toBe(0);
    const recoveredProjection = (
      await db
        .select({
          indexId: caseLawCorpusIndexProjections.indexId,
          pendingAction: caseLawCorpusIndexProjections.pendingAction,
          pendingHash: caseLawCorpusIndexProjections.pendingHash,
          pendingIndexIds: caseLawCorpusIndexProjections.pendingIndexIds,
        })
        .from(caseLawCorpusIndexProjections)
        .where(
          and(
            eq(caseLawCorpusIndexProjections.generation, generation),
            eq(caseLawCorpusIndexProjections.decisionId, staleDecisionId),
          ),
        )
    ).at(0);
    expect(recoveredProjection).toMatchObject({
      indexId: successorIndexId,
      pendingAction: "index",
      pendingHash: "stale",
    });
    expect(recoveredProjection?.pendingIndexIds).toEqual(
      expect.arrayContaining([staleIndexId, successorIndexId]),
    );
    expect(await readCheckpoint(generation)).toMatchObject({
      cursorCreatedAt: CREATED_AT,
      cursorId: staleDecisionId,
      leaseExpiresAt: null,
      leaseToken: null,
      status: "running",
    });
    await db
      .delete(caseLawDecisions)
      .where(eq(caseLawDecisions.id, staleDecisionId));
  },
  { timeout: 30_000 },
);

test(
  "lease-loss compensation retains an exact late append target after erasure",
  async () => {
    const generation = "case_law_v33";
    const lateIndexId = corpusIndexId(generation, "CZE");
    await db.insert(caseLawCorpusIndexBackfills).values({
      generation,
      snapshotAt: await nextBackfillSnapshotAt(),
      status: "complete",
    });
    await db
      .update(caseLawDecisions)
      .set({ contentHash: null, indexedHash: null })
      .where(eq(caseLawDecisions.id, publicFirstId));
    const lease = await acquireCaseLawCorpusGenerationLease({
      generation,
      scopedDb,
    });
    expect(lease).not.toBeNull();

    try {
      await lease?.recoverRemoteEffectLeaseLoss({
        entityIds: [publicFirstId],
        indexId: lateIndexId,
      });
      const projection = (
        await db
          .select()
          .from(caseLawCorpusIndexProjections)
          .where(
            and(
              eq(caseLawCorpusIndexProjections.generation, generation),
              eq(caseLawCorpusIndexProjections.decisionId, publicFirstId),
            ),
          )
      ).at(0);
      expect(projection).toMatchObject({
        pendingAction: "delete",
        pendingHash: null,
        pendingIndexIds: [lateIndexId],
      });
    } finally {
      await lease?.release();
      await db
        .update(caseLawDecisions)
        .set({ contentHash: "first", indexedHash: null })
        .where(eq(caseLawDecisions.id, publicFirstId));
      await db
        .delete(caseLawCorpusIndexBackfills)
        .where(eq(caseLawCorpusIndexBackfills.generation, generation));
    }
  },
  { timeout: 30_000 },
);

test("the database rejects every malformed corpus source descriptor shape", async () => {
  const malformedDescriptors = [
    {},
    null,
    {
      allowsDerivedAi: true,
      allowsRedistribution: null,
      attribution: null,
      license: "public-domain",
    },
  ];
  const assertRejected = async (index = 0): Promise<void> => {
    const descriptor = malformedDescriptors.at(index);
    if (descriptor === undefined) {
      return;
    }
    const encoded = JSON.stringify(descriptor);
    const rejection: unknown = await db
      .execute(
        sql`UPDATE ${caseLawSources}
            SET descriptor = ${encoded}::jsonb
            WHERE id = ${publicSourceId}`,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(rejection).toBeInstanceOf(Error);
    await assertRejected(index + 1);
  };

  await assertRejected();
});

test(
  "hash-null refreshes remain in the bounded pending selection after moving jurisdiction",
  async () => {
    const movedId = toSafeId<"caseLawDecision">(
      "00000000-0000-4000-8000-000000000099",
    );
    await db.insert(caseLawDecisions).values({
      caseNumber: "99 T 99/2026",
      contentHash: "moved-content",
      country: "SVK",
      court: "Moved court",
      createdAt: CREATED_AT,
      fulltext: "moved text",
      id: movedId,
      indexedGeneration: corpusIndexId(GENERATION, "CZE"),
      indexedHash: null,
      language: "sk",
      languageGroupKey: "moved",
      slug: "moved",
      sourceId: publicSourceId,
    });

    try {
      const pending = await caseLawCorpusIndexAdapter.selectMissing(scopedDb, {
        generation: GENERATION,
        limit: 100,
      });
      expect(pending.some(({ id }) => id === movedId)).toBe(true);

      await db
        .update(caseLawDecisions)
        .set({ indexedHash: "moved-content" })
        .where(eq(caseLawDecisions.id, movedId));
      const current = await caseLawCorpusIndexAdapter.selectMissing(scopedDb, {
        generation: GENERATION,
        limit: 100,
      });
      expect(current.some(({ id }) => id === movedId)).toBe(false);
    } finally {
      await db.delete(caseLawDecisions).where(eq(caseLawDecisions.id, movedId));
    }
  },
  { timeout: 30_000 },
);

test(
  "generation replay revisits a refreshed row already pointing at its target",
  async () => {
    const generation = "case_law_v34";
    const refreshedId = toSafeId<"caseLawDecision">(
      "00000000-0000-4000-8000-000000000098",
    );
    await db.insert(caseLawDecisions).values({
      caseNumber: "98 T 98/2026",
      contentHash: "refreshed-content",
      country: "CZE",
      court: "Refreshed court",
      createdAt: CREATED_AT,
      fulltext: "refreshed text",
      id: refreshedId,
      indexedGeneration: corpusIndexId(generation, "CZE"),
      indexedHash: null,
      language: "cs",
      languageGroupKey: "refreshed",
      slug: "refreshed",
      sourceId: publicSourceId,
    });

    const sent: SafeId<"caseLawDecision">[] = [];
    const backfill = createCaseLawGenerationBackfill({
      backfillRows: async (_scopedDb, rows, _generation, options) => {
        await options.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: noRemoteEffectCompensation,
        });
        sent.push(...rows.map(({ id }) => id));
        return rows.length;
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000300",
      removeProjection: ignoreProjectionRemoval,
    });

    try {
      expect(await backfill(scopedDb, 100, generation)).toMatchObject({
        status: "advanced",
      });
      expect(sent).toContain(refreshedId);
    } finally {
      await db
        .delete(caseLawDecisions)
        .where(eq(caseLawDecisions.id, refreshedId));
    }
  },
  { timeout: 30_000 },
);

test(
  "rehydration admits exactly a current, non-pending generation projection",
  async () => {
    const generation = "case_law_v35";
    const decisionId = toSafeId<"caseLawDecision">(
      "00000000-0000-4000-8000-000000000097",
    );
    const indexId = corpusIndexId(generation, "CZE");
    await db.insert(caseLawCorpusIndexBackfills).values({
      generation,
      snapshotAt: new Date("2026-07-31T15:00:00.000Z"),
      status: "complete",
    });
    await db.insert(caseLawDecisions).values({
      caseNumber: "97 T 97/2026",
      contentHash: "current",
      country: "CZE",
      court: "Projection court",
      createdAt: CREATED_AT,
      fulltext: "projection text",
      id: decisionId,
      indexedHash: "current",
      language: "cs",
      languageGroupKey: "projection",
      slug: "projection",
      sourceId: publicSourceId,
    });
    const visible = async () =>
      (
        await db
          .select({ id: caseLawDecisions.id })
          .from(caseLawDecisions)
          .leftJoin(
            caseLawCorpusIndexProjections,
            caseLawCorpusProjectionJoin(generation),
          )
          .where(
            and(
              eq(caseLawDecisions.id, decisionId),
              currentCaseLawCorpusProjection(generation),
            ),
          )
      ).length === 1;

    try {
      expect(await visible()).toBe(true);
      await db.insert(caseLawCorpusIndexProjections).values({
        decisionId,
        generation,
        indexedHash: "current",
        indexId,
      });
      expect(await visible()).toBe(true);

      await db
        .update(caseLawCorpusIndexProjections)
        .set({
          pendingAction: "index",
          pendingHash: "current",
          pendingIndexIds: [indexId],
        })
        .where(eq(caseLawCorpusIndexProjections.generation, generation));
      expect(await visible()).toBe(false);

      await db
        .update(caseLawCorpusIndexProjections)
        .set({
          indexId: corpusIndexId(generation, "SVK"),
          pendingAction: null,
          pendingHash: null,
          pendingIndexIds: [],
        })
        .where(eq(caseLawCorpusIndexProjections.generation, generation));
      expect(await visible()).toBe(false);

      await db
        .update(caseLawCorpusIndexProjections)
        .set({ indexId, indexedHash: "stale" })
        .where(eq(caseLawCorpusIndexProjections.generation, generation));
      expect(await visible()).toBe(false);

      await db
        .update(caseLawCorpusIndexProjections)
        .set({ pendingAction: "delete", pendingHash: null })
        .where(eq(caseLawCorpusIndexProjections.generation, generation));
      expect(await visible()).toBe(false);
    } finally {
      await db
        .delete(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId));
      await db
        .delete(caseLawCorpusIndexBackfills)
        .where(eq(caseLawCorpusIndexBackfills.generation, generation));
    }
  },
  { timeout: 30_000 },
);

test(
  "reconciles source eligibility after the generation snapshot has passed",
  async () => {
    const generation = "case_law_v36";
    await db.insert(caseLawCorpusIndexBackfills).values({
      generation,
      snapshotAt: await nextBackfillSnapshotAt(),
      status: "complete",
    });
    const indexed: SafeId<"caseLawDecision">[] = [];
    const removed: SafeId<"caseLawDecision">[] = [];
    const backfill = createCaseLawGenerationBackfill({
      backfillRows: async (runnerDb, rows, rebuildGeneration, options) => {
        await options.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: noRemoteEffectCompensation,
        });
        indexed.push(...rows.map(({ id }) => id));
        const row = rows.at(0);
        if (!row) {
          return 0;
        }
        let markedCount = 0;
        await runnerDb(async (tx) => {
          await options.beforeDatabaseMark(tx);
          const marked = await caseLawCorpusIndexAdapter.markIndexedBatch(tx, {
            indexId: corpusIndexId(rebuildGeneration, row.country),
            mode: {
              generation: rebuildGeneration,
              type: "generation-rebuild",
            },
            now: new Date("2026-07-31T13:00:00.000Z"),
            rows,
          });
          markedCount = marked.size;
        });
        return markedCount;
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000900",
      removeProjection: async (runnerDb, { options, row }) => {
        await options.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: noRemoteEffectCompensation,
        });
        removed.push(row.id);
        await runnerDb(async (tx) => {
          await options.beforeDatabaseMark(tx);
          await tx
            .delete(caseLawCorpusIndexProjections)
            .where(
              and(
                eq(caseLawCorpusIndexProjections.generation, generation),
                eq(caseLawCorpusIndexProjections.decisionId, row.id),
              ),
            );
        });
      },
    });

    try {
      await db
        .update(caseLawSources)
        .set({
          descriptor: {
            allowsDerivedAi: true,
            allowsRedistribution: true,
            attribution: null,
            license: "public-domain",
          },
        })
        .where(eq(caseLawSources.id, restrictedSourceId));
      // pushSchema creates tables and constraints but not migration triggers;
      // this is the exact bounded work item produced by the SQL trigger.
      await queueSourceReconciliation(generation, restrictedSourceId);

      expect(await backfill(scopedDb, 10, generation)).toEqual({
        indexed: 1,
        status: "advanced",
      });
      expect(indexed).toEqual([restrictedId]);
      expect(await backfill(scopedDb, 10, generation)).toMatchObject({
        status: "advanced",
      });

      await db
        .update(caseLawSources)
        .set({
          descriptor: {
            allowsDerivedAi: false,
            allowsRedistribution: false,
            attribution: null,
            license: "restricted",
          },
        })
        .where(eq(caseLawSources.id, restrictedSourceId));
      await queueSourceReconciliation(generation, restrictedSourceId);

      expect(await backfill(scopedDb, 10, generation)).toEqual({
        indexed: 0,
        status: "advanced",
      });
      expect(removed).toEqual([restrictedId]);
      expect(
        await db
          .select()
          .from(caseLawCorpusIndexProjections)
          .where(
            and(
              eq(caseLawCorpusIndexProjections.generation, generation),
              eq(caseLawCorpusIndexProjections.decisionId, restrictedId),
            ),
          ),
      ).toHaveLength(0);
    } finally {
      await db
        .update(caseLawSources)
        .set({
          descriptor: {
            allowsDerivedAi: false,
            allowsRedistribution: false,
            attribution: null,
            license: "restricted",
          },
        })
        .where(eq(caseLawSources.id, restrictedSourceId));
      await db
        .delete(caseLawCorpusIndexBackfills)
        .where(eq(caseLawCorpusIndexBackfills.generation, generation));
    }
  },
  { timeout: 30_000 },
);

test(
  "source reconciliation drains its creation watermark despite later inserts",
  async () => {
    const generation = "case_law_v37";
    const lateDecisionId = toSafeId<"caseLawDecision">(
      "00000000-0000-4000-8000-000000000015",
    );
    const indexed: SafeId<"caseLawDecision">[] = [];
    const backfill = createCaseLawGenerationBackfill({
      backfillRows: async (_runnerDb, rows, _generation, options) => {
        await options.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: noRemoteEffectCompensation,
        });
        indexed.push(...rows.map(({ id }) => id));
        return rows.length;
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000901",
      removeProjection: async () => {
        await Promise.resolve();
      },
    });

    await db.insert(caseLawCorpusIndexBackfills).values({
      generation,
      snapshotAt: await nextBackfillSnapshotAt(),
      status: "complete",
    });
    try {
      await db
        .update(caseLawSources)
        .set({
          descriptor: {
            allowsDerivedAi: true,
            allowsRedistribution: true,
            attribution: null,
            license: "public-domain",
          },
        })
        .where(eq(caseLawSources.id, restrictedSourceId));
      await queueSourceReconciliation(generation, restrictedSourceId);

      await db.insert(caseLawDecisions).values({
        caseNumber: "5 T 5/2026",
        contentHash: "late",
        country: "CZE",
        court: "Test court",
        createdAt: new Date("2026-07-30T12:00:01.000Z"),
        decisionDate: "2026-01-01",
        fulltext: "late text",
        id: lateDecisionId,
        language: "cs",
        languageGroupKey: "late",
        slug: "late",
        sourceId: restrictedSourceId,
      });

      expect(await backfill(scopedDb, 1, generation)).toEqual({
        indexed: 1,
        status: "advanced",
      });
      expect(await backfill(scopedDb, 1, generation)).toEqual({
        indexed: 0,
        status: "advanced",
      });
      expect(indexed).toEqual([restrictedId]);
      expect(
        await db
          .select()
          .from(caseLawCorpusIndexSourceReconciliations)
          .where(
            eq(caseLawCorpusIndexSourceReconciliations.generation, generation),
          ),
      ).toHaveLength(0);
    } finally {
      await db
        .delete(caseLawDecisions)
        .where(eq(caseLawDecisions.id, lateDecisionId));
      await db
        .update(caseLawSources)
        .set({
          descriptor: {
            allowsDerivedAi: false,
            allowsRedistribution: false,
            attribution: null,
            license: "restricted",
          },
        })
        .where(eq(caseLawSources.id, restrictedSourceId));
      await db
        .delete(caseLawCorpusIndexBackfills)
        .where(eq(caseLawCorpusIndexBackfills.generation, generation));
    }
  },
  { timeout: 30_000 },
);

test("rejects a pending hash without a pending action", async () => {
  const generation = "case_law_v38";
  await db.insert(caseLawCorpusIndexBackfills).values({
    generation,
    snapshotAt: await nextBackfillSnapshotAt(),
    status: "complete",
  });

  const rejection: unknown = await db
    .insert(caseLawCorpusIndexProjections)
    .values({
      decisionId: publicFirstId,
      generation,
      pendingHash: "orphaned",
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(rejection).toBeInstanceOf(Error);

  const missingTarget: unknown = await db
    .insert(caseLawCorpusIndexProjections)
    .values({
      decisionId: publicFirstId,
      generation,
      pendingAction: "index",
      pendingHash: "first",
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(missingTarget).toBeInstanceOf(Error);
});
