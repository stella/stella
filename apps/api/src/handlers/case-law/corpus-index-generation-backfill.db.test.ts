import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
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
  clearIneligibleGenerationProjection,
  createCaseLawGenerationBackfill,
  generationProjectionTargetIds,
  reserveGenerationProjectionTargets,
} from "@/api/handlers/case-law/corpus-index";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { timestampCasToken } from "@/api/lib/db/timestamp-cas";
import { ConcurrentModificationError } from "@/api/lib/errors/tagged-errors";
import {
  caseLawCorpusProjectionJoin,
  currentCaseLawCorpusProjection,
} from "@/api/lib/legal-search/case-law-corpus-projection";
import {
  CORPUS_INDEX_COMMIT,
  CorpusIndexError,
} from "@/api/lib/legal-search/corpus-index-client";
import type { CorpusIndexCommitMode } from "@/api/lib/legal-search/corpus-index-client";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const generationMigrationSource = new URL(
  "../../../drizzle/20260731170000_case_law_corpus_generation_backfill/migration.sql",
  import.meta.url,
);
const INDEX_ID_FUNCTION =
  "CREATE OR REPLACE FUNCTION case_law_corpus_index_id(generation text, country text)";
const PROJECTION_TRIGGER_FUNCTION =
  "CREATE OR REPLACE FUNCTION enqueue_case_law_corpus_index_projection()";
const PROJECTION_TRIGGER =
  "CREATE TRIGGER case_law_decisions_enqueue_corpus_index_projection";
const PROJECTION_TRIGGER_STATEMENT =
  /\b(?:CREATE|DROP) TRIGGER (?:IF EXISTS )?case_law_decisions_enqueue_corpus_index_projection\b/u;

/**
 * The statements of the last migration containing `marker`. `db:push` builds
 * the test database from the schema, which carries no triggers or functions,
 * so a test that needs them installs them from a migration. Which migration
 * is derived, not named: migrations apply in directory order, so the last one
 * that redefines an object is the definition a database ends up with, and a
 * later migration replacing it moves this with it.
 */
const latestMigrationStatements = async (marker: string): Promise<string[]> => {
  const drizzleDir = new URL("../../../drizzle/", import.meta.url);
  const migrations = [
    ...new Bun.Glob("*/migration.sql").scanSync(Bun.fileURLToPath(drizzleDir)),
  ].sort();
  let latest: string | undefined;
  for (const migration of migrations) {
    const source = await Bun.file(new URL(migration, drizzleDir)).text();
    if (source.includes(marker)) {
      latest = source;
    }
  }
  if (latest === undefined) {
    throw new Error(`no migration contains ${marker}`);
  }
  return latest
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
};
const CREATED_AT = new Date("2026-07-30T12:00:00.000Z");
const GENERATION = "case_law_v2";
/**
 * The walk's order, restated here so the fixtures read in it. Undated rows
 * carry `-infinity`, which is the cursor value the runner stores for them.
 */
const UNDATED_WALK_DATE = "-infinity";
const WALK_DATE = sql`coalesce(${caseLawDecisions.decisionDate}, '-infinity'::date)`;
const noRemoteEffectCompensation = async (): Promise<void> => {
  await Promise.resolve();
};
const expectConstraintViolation = (
  error: unknown,
  constraintName: string,
): void => {
  const messages: string[] = [];
  let cause = error;
  while (cause instanceof Error) {
    messages.push(cause.message);
    cause = cause.cause;
  }
  expect(messages.join("\n")).toContain(constraintName);
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

let client: Awaited<ReturnType<typeof createTestPglite>> | undefined;
let db: ReturnType<typeof drizzle>;

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });

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

/** A batch where every selected row settled, with nothing deferred. */
const indexedOutcome = (indexed: number) => ({
  indexed,
  refreshed: 0,
  unread: 0,
});

const completeRemoteEffect = async (): Promise<void> => {
  await Promise.resolve();
};

/**
 * Install the projection trigger as the migrations define it, so a test runs
 * against the deployed definition rather than a paraphrase of it: the index
 * id function the trigger calls, the trigger function, then the trigger, each
 * from the last migration defining it.
 */
const installProjectionTrigger = async (): Promise<void> => {
  const functionStatements = [
    ...(await latestMigrationStatements(INDEX_ID_FUNCTION)).filter(
      (statement) => statement.includes(INDEX_ID_FUNCTION),
    ),
    ...(await latestMigrationStatements(PROJECTION_TRIGGER_FUNCTION)).filter(
      (statement) => statement.includes(PROJECTION_TRIGGER_FUNCTION),
    ),
  ];
  expect(functionStatements).toHaveLength(2);
  // The replacement drop (`DROP TRIGGER IF EXISTS ...`) and the creation.
  const triggerStatements = (
    await latestMigrationStatements(PROJECTION_TRIGGER)
  ).filter((statement) => PROJECTION_TRIGGER_STATEMENT.test(statement));
  // The trigger fires on the columns that reach the document or the walk's
  // position. A decision date now does both, so it has to be in this list.
  expect(triggerStatements.at(-1)).toContain(
    "UPDATE OF content_hash, indexed_hash, country, decision_date",
  );
  for (const statement of [...functionStatements, ...triggerStatements]) {
    await db.execute(sql.raw(statement));
  }
};

const queueSourceReconciliation = async (
  generation: string,
  sourceId: SafeId<"caseLawSource">,
): Promise<void> => {
  const boundary = (
    await db
      .select({
        createdAtToken: timestampCasToken(caseLawDecisions.createdAt),
        id: caseLawDecisions.id,
      })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.sourceId, sourceId))
      .orderBy(desc(caseLawDecisions.createdAt), desc(caseLawDecisions.id))
      .limit(1)
  ).at(0);
  // The SQL trigger stamps the watermark in the database, so the fixture
  // carries the exact stored timestamp rather than a truncated `Date`.
  const upperCreatedAt = boundary
    ? sql`${boundary.createdAtToken}::timestamptz`
    : null;
  await db
    .insert(caseLawCorpusIndexSourceReconciliations)
    .values({
      generation,
      sourceId,
      upperCreatedAt,
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
        upperCreatedAt,
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
        return indexedOutcome(0);
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

test("writer leases fence valid historical generation prefixes", async () => {
  const generation = "legal_v2";
  const first = await acquireCaseLawCorpusGenerationLease({
    generation,
    scopedDb,
  });
  expect(first).not.toBeNull();

  const contender = await acquireCaseLawCorpusGenerationLease({
    generation,
    scopedDb,
  });
  expect(contender).toBeNull();

  await first?.release();
});

test(
  "every generation completes its snapshot despite immutable precedence",
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
    const readConcurrencies: (number | undefined)[] = [];
    const backfill = createCaseLawGenerationBackfill({
      backfillRows: async (_runnerDb, rows, _generation, options) => {
        await options.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: noRemoteEffectCompensation,
        });
        writes += 1;
        readConcurrencies.push(options.readConcurrency);
        return indexedOutcome(rows.length);
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000060",
      removeProjection: ignoreProjectionRemoval,
    });

    try {
      expect(
        await backfill(scopedDb, 1, rebuildGeneration, { readConcurrency: 32 }),
      ).toEqual({
        indexed: 1,
        status: "advanced",
      });
      expect(await backfill(scopedDb, 1, servingGeneration)).toEqual({
        indexed: 1,
        status: "advanced",
      });
      expect(writes).toBe(2);
      // The caller's read concurrency reaches the rows; unset stays unset so
      // the indexer's default applies.
      expect(readConcurrencies).toEqual([32, undefined]);
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
    backfillRows: async () => indexedOutcome(0),
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

test("country guard rejects new malformed values without blocking legacy repairs", async () => {
  const rejectedDecisionId = toSafeId<"caseLawDecision">(
    "00000000-0000-4000-8000-000000000063",
  );
  const legacyDecisionId = toSafeId<"caseLawDecision">(
    "00000000-0000-4000-8000-000000000064",
  );
  await db.insert(caseLawDecisions).values({
    caseNumber: "legacy malformed jurisdiction",
    country: "CZ1",
    court: "Legacy court",
    id: legacyDecisionId,
    language: "cs",
    languageGroupKey: "legacy-malformed-jurisdiction",
    slug: "legacy-malformed-jurisdiction",
    sourceId: publicSourceId,
  });

  try {
    const migration = await Bun.file(generationMigrationSource).text();
    const countryGuardStatements = migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) =>
        statement.includes("case_law_decisions_corpus_country_shape"),
      );
    expect(countryGuardStatements).toHaveLength(3);
    for (const statement of countryGuardStatements) {
      await db.execute(sql.raw(statement));
    }

    await db
      .update(caseLawDecisions)
      .set({ caseNumber: "legacy repair remains possible" })
      .where(eq(caseLawDecisions.id, legacyDecisionId));
    expect(
      await db
        .select({ country: caseLawDecisions.country })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, legacyDecisionId)),
    ).toEqual([{ country: "CZ1" }]);

    const insertRejection: unknown = await db
      .insert(caseLawDecisions)
      .values({
        caseNumber: "invalid jurisdiction",
        country: "CZ1",
        court: "Invalid court",
        id: rejectedDecisionId,
        language: "cs",
        languageGroupKey: "invalid-jurisdiction",
        slug: "invalid-jurisdiction",
        sourceId: publicSourceId,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expectConstraintViolation(
      insertRejection,
      "case_law_decisions_corpus_country_shape",
    );

    const updateRejection: unknown = await db
      .update(caseLawDecisions)
      .set({ country: "CZ1" })
      .where(eq(caseLawDecisions.id, publicFirstId))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expectConstraintViolation(
      updateRejection,
      "case_law_decisions_corpus_country_shape",
    );
    expect(
      await db
        .select({ country: caseLawDecisions.country })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, publicFirstId)),
    ).toEqual([{ country: "CZE" }]);
    expect(
      await db
        .select({ id: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, rejectedDecisionId)),
    ).toHaveLength(0);
  } finally {
    await db
      .delete(caseLawDecisions)
      .where(eq(caseLawDecisions.id, legacyDecisionId));
  }
});

test("contentless inserts never create deletion projection work", async () => {
  const generation = "case_law_v63";
  const decisionId = toSafeId<"caseLawDecision">(
    "00000000-0000-4000-8000-000000000163",
  );
  await db.insert(caseLawCorpusIndexBackfills).values({
    generation,
    snapshotAt: await nextBackfillSnapshotAt(),
    status: "complete",
  });

  try {
    await installProjectionTrigger();

    await db.insert(caseLawDecisions).values({
      caseNumber: "63 T 63/2026",
      country: "CZE",
      court: "Insert trigger court",
      createdAt: CREATED_AT,
      id: decisionId,
      language: "cs",
      languageGroupKey: "insert-trigger",
      slug: "insert-trigger",
      sourceId: publicSourceId,
    });

    expect(
      await db
        .select()
        .from(caseLawCorpusIndexProjections)
        .where(eq(caseLawCorpusIndexProjections.decisionId, decisionId)),
    ).toHaveLength(0);
  } finally {
    await db.execute(
      sql.raw(`DROP TRIGGER IF EXISTS case_law_decisions_enqueue_corpus_index_projection
        ON case_law_decisions`),
    );
    await db.execute(
      sql.raw(
        "DROP FUNCTION IF EXISTS enqueue_case_law_corpus_index_projection()",
      ),
    );
    await db
      .delete(caseLawDecisions)
      .where(eq(caseLawDecisions.id, decisionId));
    await db
      .delete(caseLawCorpusIndexBackfills)
      .where(eq(caseLawCorpusIndexBackfills.generation, generation));
  }
});

test(
  "replays the snapshot once and reconciles pending rows after completion",
  async () => {
    const sent: SafeId<"caseLawDecision">[][] = [];
    const commits: CorpusIndexCommitMode[] = [];
    let guardedPages = 0;
    let lease = 0;
    const backfill = createCaseLawGenerationBackfill({
      backfillRows: async (runnerDb, rows, rebuildGeneration, options) => {
        await options.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: noRemoteEffectCompensation,
        });
        sent.push(rows.map((row) => row.id));
        commits.push(options.commit);
        guardedPages += 1;
        await runnerDb(async (tx) => {
          await options.beforeDatabaseMark(tx);
          await tx
            .delete(caseLawCorpusIndexProjections)
            .where(
              eq(caseLawCorpusIndexProjections.generation, rebuildGeneration),
            );
        });
        return indexedOutcome(rows.length);
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
    // A row queued after completion drains through the completed path.
    await db.insert(caseLawCorpusIndexProjections).values({
      decisionId: publicLastId,
      generation: GENERATION,
      pendingAction: "index",
      pendingHash: "last",
      pendingIndexIds: [corpusIndexId(GENERATION, "CZE")],
    });
    expect(await backfill(scopedDb, 2, GENERATION)).toEqual({
      indexed: 1,
      status: "advanced",
    });

    // Same-timestamp rows are visited in UUID order, exactly once. Restricted
    // and incomplete records advance the keyset cursor as terminal skips but
    // never cross the index boundary.
    expect(sent).toEqual([
      [publicFirstId],
      [publicLastId],
      [publicFirstId],
      [publicLastId],
    ]);
    expect(guardedPages).toBe(4);
    // Snapshot pages and the running drain are bulk, verified by the census;
    // the completed generation's drain is the live path and must not be
    // marked on acceptance alone.
    expect(commits).toEqual([
      CORPUS_INDEX_COMMIT.auto,
      CORPUS_INDEX_COMMIT.auto,
      CORPUS_INDEX_COMMIT.auto,
      CORPUS_INDEX_COMMIT.waitFor,
    ]);
    const checkpoint = await readCheckpoint(GENERATION);
    expect(checkpoint).toMatchObject({
      cursorId: publicLastId,
      cursorWalkDate: "2026-01-01",
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
        return indexedOutcome(rows.length);
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
            return indexedOutcome(0);
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
                  reservations: new Map(
                    rows.map((selected) => [
                      selected.id,
                      {
                        indexIds: selected.generationPendingIndexIds,
                        revision: selected.generationPendingRevision,
                        mayHaveCopy: true,
                      },
                    ]),
                  ),
                  type: "generation-rebuild",
                },
                now: new Date("2026-07-31T13:00:00.000Z"),
                rows,
              },
            );
            indexed = marked.size;
          });
          return indexedOutcome(indexed);
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
        .set({ country: "POL" })
        .where(eq(caseLawDecisions.id, publicFirstId));
      await db
        .update(caseLawCorpusIndexProjections)
        .set({
          pendingAction: "index",
          pendingHash: "first",
          pendingIndexIds: [corpusIndexId(generation, "POL")],
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
      expect(movedProjection?.indexId).toBe(corpusIndexId(generation, "POL"));
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
  "a finalizer settles only the reservation epoch it cleaned",
  async () => {
    const generation = "case_law_v61";
    const decisionId = toSafeId<"caseLawDecision">(
      "00000000-0000-4000-8000-000000000061",
    );
    const target = corpusIndexId(generation, "CZE");
    await db.insert(caseLawCorpusIndexBackfills).values({
      generation,
      snapshotAt: await nextBackfillSnapshotAt(),
      status: "complete",
    });
    await db.insert(caseLawDecisions).values({
      caseNumber: "61 T 61/2026",
      contentHash: "revision-fence",
      country: "CZE",
      court: "Revision court",
      createdAt: CREATED_AT,
      fulltext: "revision fence",
      id: decisionId,
      language: "cs",
      languageGroupKey: "revision-fence",
      slug: "revision-fence",
      sourceId: publicSourceId,
    });
    await db.insert(caseLawCorpusIndexProjections).values({
      decisionId,
      generation,
      pendingAction: "index",
      pendingHash: "revision-fence",
      pendingIndexIds: [target],
      pendingRevision: 2,
    });

    try {
      const rows = await caseLawCorpusIndexAdapter.selectMissing(scopedDb, {
        generation,
        limit: 100,
      });
      const row = rows.find(({ id }) => id === decisionId);
      expect(row).toBeDefined();
      if (!row) {
        return;
      }
      const mark = async (revision: number) =>
        await scopedDb(
          async (tx) =>
            await caseLawCorpusIndexAdapter.markIndexedBatch(tx, {
              indexId: target,
              mode: {
                generation,
                reservations: new Map([
                  [row.id, { indexIds: [target], revision, mayHaveCopy: true }],
                ]),
                type: "generation-rebuild",
              },
              now: new Date("2026-07-31T13:00:00.000Z"),
              rows: [row],
            }),
        );

      expect((await mark(1)).has(decisionId)).toBe(true);
      expect(
        (
          await db
            .select()
            .from(caseLawCorpusIndexProjections)
            .where(
              and(
                eq(caseLawCorpusIndexProjections.generation, generation),
                eq(caseLawCorpusIndexProjections.decisionId, decisionId),
              ),
            )
        ).at(0),
      ).toMatchObject({
        pendingAction: "index",
        pendingHash: "revision-fence",
        pendingIndexIds: [target],
        pendingRevision: 2,
      });

      expect((await mark(2)).has(decisionId)).toBe(true);
      expect(
        (
          await db
            .select()
            .from(caseLawCorpusIndexProjections)
            .where(
              and(
                eq(caseLawCorpusIndexProjections.generation, generation),
                eq(caseLawCorpusIndexProjections.decisionId, decisionId),
              ),
            )
        ).at(0),
      ).toMatchObject({
        pendingAction: null,
        pendingHash: null,
        pendingIndexIds: [],
        pendingRevision: 2,
      });
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
  "append reservation rechecks source policy under the database lock",
  async () => {
    const generation = "case_law_v62";
    const sourceId = toSafeId<"caseLawSource">(
      "00000000-0000-4000-8000-000000000062",
    );
    const decisionId = toSafeId<"caseLawDecision">(
      "00000000-0000-4000-8000-000000000162",
    );
    await db.insert(caseLawSources).values({
      adapterKey: "reservation-policy",
      id: sourceId,
      name: "reservation policy",
    });
    await db.insert(caseLawDecisions).values({
      caseNumber: "62 T 62/2026",
      contentHash: "reservation-policy",
      country: "CZE",
      court: "Reservation court",
      createdAt: CREATED_AT,
      fulltext: "reservation policy",
      id: decisionId,
      language: "cs",
      languageGroupKey: "reservation-policy",
      slug: "reservation-policy",
      sourceId,
    });
    await db.insert(caseLawCorpusIndexBackfills).values({
      generation,
      snapshotAt: await nextBackfillSnapshotAt(),
      status: "complete",
    });

    try {
      const selected = await caseLawCorpusIndexAdapter.selectMissing(scopedDb, {
        generation,
        limit: 100,
      });
      const staleRow = selected.find(({ id }) => id === decisionId);
      expect(staleRow).toBeDefined();
      if (!staleRow) {
        return;
      }

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
        .where(eq(caseLawSources.id, sourceId));

      const reservations = await scopedDb(
        async (tx) =>
          await reserveGenerationProjectionTargets(tx, {
            generation,
            rows: [staleRow],
          }),
      );
      expect(reservations.has(decisionId)).toBe(false);
      expect(
        await db
          .select()
          .from(caseLawCorpusIndexProjections)
          .where(
            and(
              eq(caseLawCorpusIndexProjections.generation, generation),
              eq(caseLawCorpusIndexProjections.decisionId, decisionId),
            ),
          ),
      ).toHaveLength(0);
    } finally {
      await db
        .delete(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId));
      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      await db
        .delete(caseLawCorpusIndexBackfills)
        .where(eq(caseLawCorpusIndexBackfills.generation, generation));
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
        return indexedOutcome(rows.length);
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
    // The pending drain now runs under the running lease, before the walk
    // observes its drained snapshot and completes.
    expect(await readCheckpoint(generation)).toMatchObject({
      status: "running",
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
      cursorId: null,
      cursorWalkDate: null,
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
        return { indexed: 0, refreshed: 1, unread: 0 };
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
    // The shortfall reason is the point: a page that deferred a row to a
    // concurrent refresh has to say so, or the log cannot tell that apart
    // from an unreadable object or a lost update.
    expect(incompleteRejection).toMatchObject({
      message: expect.stringMatching(
        /^generation backfill page did not reach a fixed point \(selected=\d+ indexed=0 refreshed=1 unread=0\)$/u,
      ),
    });
    expect(await readCheckpoint(retryGeneration)).toMatchObject({
      cursorId: null,
      cursorWalkDate: null,
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
        return indexedOutcome(rows.length);
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
  "releases the checkpoint lease when snapshot selection fails",
  async () => {
    const generation = "case_law_v80";
    const leaseToken = "00000000-0000-4000-8000-000000000180";
    let claimObserved = false;
    let postClaimTransactions = 0;
    let injected = false;
    let backfillCalls = 0;
    const failingScopedDb = async <T>(
      callback: (tx: Transaction) => Promise<T>,
    ): Promise<T> => {
      // The first five post-claim transactions renew the writer and
      // checkpoint leases, then drain pending projections. The next one is
      // the snapshot page read: fail it once to model an expired pool
      // connection while the running arm still owns the checkpoint lease.
      if (!injected && claimObserved && postClaimTransactions >= 5) {
        injected = true;
        throw new Error("snapshot selection failed");
      }

      const result = await scopedDb(callback);
      const checkpoint = await readCheckpoint(generation);
      if (checkpoint?.leaseToken === leaseToken) {
        if (claimObserved) {
          postClaimTransactions += 1;
        } else {
          claimObserved = true;
        }
      }
      return result;
    };
    const backfill = createCaseLawGenerationBackfill({
      backfillRows: async () => {
        backfillCalls += 1;
        return indexedOutcome(0);
      },
      newLeaseToken: () => leaseToken,
      removeProjection: ignoreProjectionRemoval,
    });

    try {
      const rejection: unknown = await backfill(
        failingScopedDb,
        1,
        generation,
      ).then(
        () => null,
        (error: unknown) => error,
      );

      expect(rejection).toMatchObject({
        message: "snapshot selection failed",
      });
      expect(injected).toBe(true);
      expect(postClaimTransactions).toBeGreaterThanOrEqual(5);
      expect(backfillCalls).toBe(0);
      expect(await readCheckpoint(generation)).toMatchObject({
        leaseExpiresAt: null,
        leaseToken: null,
        status: "running",
      });
    } finally {
      await db
        .delete(caseLawCorpusIndexBackfills)
        .where(eq(caseLawCorpusIndexBackfills.generation, generation));
    }
  },
  { timeout: 30_000 },
);

test(
  "releases the checkpoint lease when cursor advancement fails",
  async () => {
    const generation = "case_law_v81";
    const leaseToken = "00000000-0000-4000-8000-000000000181";
    let failNextTransaction = false;
    const failingScopedDb = async <T>(
      callback: (tx: Transaction) => Promise<T>,
    ): Promise<T> => {
      if (failNextTransaction) {
        failNextTransaction = false;
        throw new Error("cursor advancement failed");
      }
      return await scopedDb(callback);
    };
    const backfill = createCaseLawGenerationBackfill({
      backfillRows: async (_runnerDb, rows, _rebuildGeneration, options) => {
        await options.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: noRemoteEffectCompensation,
        });
        failNextTransaction = true;
        return indexedOutcome(rows.length);
      },
      newLeaseToken: () => leaseToken,
      removeProjection: ignoreProjectionRemoval,
    });

    try {
      const rejection: unknown = await backfill(
        failingScopedDb,
        1,
        generation,
      ).then(
        () => null,
        (error: unknown) => error,
      );

      expect(rejection).toMatchObject({
        message: "cursor advancement failed",
      });
      expect(await readCheckpoint(generation)).toMatchObject({
        leaseExpiresAt: null,
        leaseToken: null,
        status: "running",
      });
    } finally {
      await db
        .delete(caseLawCorpusIndexBackfills)
        .where(eq(caseLawCorpusIndexBackfills.generation, generation));
    }
  },
  { timeout: 30_000 },
);

test(
  "does not reopen checkpoint cleanup after cursor advancement released it",
  async () => {
    const generation = "case_law_v82";
    let advancementObserved = false;
    let postAdvancementTransactions = 0;
    const tracedScopedDb = async <T>(
      callback: (tx: Transaction) => Promise<T>,
    ): Promise<T> => {
      if (advancementObserved) {
        postAdvancementTransactions += 1;
      }
      const result = await scopedDb(callback);
      const checkpoint = await readCheckpoint(generation);
      if (checkpoint?.cursorId !== null && checkpoint?.leaseToken === null) {
        advancementObserved = true;
      }
      return result;
    };
    const backfill = createCaseLawGenerationBackfill({
      backfillRows: async (_runnerDb, rows, _generation, options) => {
        await options.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: noRemoteEffectCompensation,
        });
        return indexedOutcome(rows.length);
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000182",
      removeProjection: ignoreProjectionRemoval,
    });

    try {
      expect(await backfill(tracedScopedDb, 1, generation)).toMatchObject({
        indexed: 1,
        status: "advanced",
      });
      expect(advancementObserved).toBe(true);
      // Only the separate generation-writer lease release remains. A second
      // transaction would be redundant checkpoint cleanup after its CAS
      // already cleared the token and persisted the cursor.
      expect(postAdvancementTransactions).toBe(1);
    } finally {
      await db
        .delete(caseLawCorpusIndexBackfills)
        .where(eq(caseLawCorpusIndexBackfills.generation, generation));
    }
  },
  { timeout: 30_000 },
);

test(
  "returns completion when the retried complete lease release succeeds",
  async () => {
    const generation = "case_law_v83";
    const leaseToken = "00000000-0000-4000-8000-000000000183";
    let releaseFailures = 0;
    await db.insert(caseLawCorpusIndexBackfills).values({
      generation,
      snapshotAt: new Date("2000-01-01T00:00:00.000Z"),
    });
    const retryingScopedDb = async <T>(
      runTransaction: (tx: Transaction) => Promise<T>,
    ): Promise<T> =>
      await db.transaction(async (tx) => {
        // SAFETY: PGlite's transaction provides the Drizzle query surface the
        // runner uses; the explicit transaction lets this test roll back the
        // first completed-checkpoint release at its exact state boundary.
        // eslint-disable-next-line typescript/no-unsafe-type-assertion
        const transaction = tx as unknown as Transaction;
        const result = await runTransaction(transaction);
        const checkpoint = (
          await transaction
            .select()
            .from(caseLawCorpusIndexBackfills)
            .where(eq(caseLawCorpusIndexBackfills.generation, generation))
            .limit(1)
        ).at(0);
        if (
          releaseFailures === 0 &&
          checkpoint?.status === "complete" &&
          checkpoint.leaseToken === null
        ) {
          releaseFailures += 1;
          throw new Error("complete lease release failed");
        }
        return result;
      });
    const backfill = createCaseLawGenerationBackfill({
      backfillRows: async () => indexedOutcome(0),
      newLeaseToken: () => leaseToken,
      removeProjection: ignoreProjectionRemoval,
    });

    try {
      expect(await backfill(retryingScopedDb, 1, generation)).toEqual({
        indexed: 0,
        status: "complete",
      });
      expect(releaseFailures).toBe(1);
      expect(await readCheckpoint(generation)).toMatchObject({
        leaseExpiresAt: null,
        leaseToken: null,
        status: "complete",
      });
    } finally {
      await db
        .delete(caseLawCorpusIndexBackfills)
        .where(eq(caseLawCorpusIndexBackfills.generation, generation));
    }
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
        return indexedOutcome(rows.length);
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
        return indexedOutcome(rows.length);
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
      cursorId: publicFirstId,
      cursorWalkDate: "2026-01-01",
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
    // POL sits in another index group, so this is a different physical index.
    const successorIndexId = corpusIndexId(generation, "POL");
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
        return indexedOutcome(rows.length);
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
              .set({ country: "POL", indexedHash: null })
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
        return indexedOutcome(rows.length);
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000400",
      removeProjection: ignoreProjectionRemoval,
    });

    try {
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
        cursorId: staleDecisionId,
        cursorWalkDate: "2026-01-01",
        leaseExpiresAt: null,
        leaseToken: null,
        status: "running",
      });
    } finally {
      await db
        .delete(caseLawDecisions)
        .where(eq(caseLawDecisions.id, staleDecisionId));
    }
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
  const legacySourceId = toSafeId<"caseLawSource">(
    "00000000-0000-4000-8000-000000000006",
  );
  const rejectedSourceId = toSafeId<"caseLawSource">(
    "00000000-0000-4000-8000-000000000007",
  );
  await db.execute(
    sql`INSERT INTO ${caseLawSources} (id, adapter_key, name, descriptor)
        VALUES (${legacySourceId}, 'legacy-malformed', 'legacy malformed', '{}'::jsonb)`,
  );

  const migration = await Bun.file(generationMigrationSource).text();
  const descriptorGuardStatements = migration
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) =>
      statement.includes("case_law_sources_descriptor_shape"),
    );
  expect(descriptorGuardStatements).toHaveLength(3);
  for (const statement of descriptorGuardStatements) {
    await db.execute(sql.raw(statement));
  }

  const malformedDescriptors = [
    {},
    null,
    {
      allowsDerivedAi: true,
      allowsRedistribution: null,
      attribution: null,
      license: "public-domain",
    },
    {
      allowsDerivedAi: true,
      allowsRedistribution: true,
      attribution: null,
      license: "unknown-license",
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
            SET descriptor = ${encoded}::text::jsonb
            WHERE id = ${publicSourceId}`,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expectConstraintViolation(rejection, "case_law_sources_descriptor_shape");
    await assertRejected(index + 1);
  };

  try {
    await db
      .update(caseLawSources)
      .set({ syncCursor: "repair-safe-checkpoint" })
      .where(eq(caseLawSources.id, legacySourceId));
    expect(
      await db
        .select({ syncCursor: caseLawSources.syncCursor })
        .from(caseLawSources)
        .where(eq(caseLawSources.id, legacySourceId)),
    ).toEqual([{ syncCursor: "repair-safe-checkpoint" }]);

    await assertRejected();

    const insertRejection: unknown = await db
      .execute(
        sql`INSERT INTO ${caseLawSources} (id, adapter_key, name, descriptor)
            VALUES (${rejectedSourceId}, 'rejected-malformed', 'rejected malformed', '{}'::jsonb)`,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expectConstraintViolation(
      insertRejection,
      "case_law_sources_descriptor_shape",
    );
  } finally {
    await db
      .delete(caseLawSources)
      .where(eq(caseLawSources.id, rejectedSourceId));
    await db
      .delete(caseLawSources)
      .where(eq(caseLawSources.id, legacySourceId));
  }
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
  "serving selectors hydrate every durable projection retry target",
  async () => {
    const generation = "case_law_v39";
    const decisionId = toSafeId<"caseLawDecision">(
      "00000000-0000-4000-8000-000000000097",
    );
    const staleIndexId = corpusIndexId(generation, "POL");
    await db.insert(caseLawCorpusIndexBackfills).values({
      generation,
      snapshotAt: await nextBackfillSnapshotAt(),
      status: "complete",
    });
    await db.insert(caseLawDecisions).values({
      caseNumber: "97 T 97/2026",
      contentHash: "pending-content",
      country: "CZE",
      court: "Pending court",
      createdAt: CREATED_AT,
      fulltext: "pending text",
      id: decisionId,
      indexedGeneration: corpusIndexId(generation, "CZE"),
      indexedHash: null,
      language: "cs",
      languageGroupKey: "pending",
      slug: "pending",
      sourceId: publicSourceId,
    });
    await db.insert(caseLawCorpusIndexProjections).values({
      decisionId,
      generation,
      pendingAction: "index",
      pendingHash: "pending-content",
      pendingIndexIds: [staleIndexId],
    });

    try {
      const pending = await caseLawCorpusIndexAdapter.selectMissing(scopedDb, {
        generation,
        limit: 100,
      });
      const row = pending.find(({ id }) => id === decisionId);
      expect(row).toMatchObject({
        generationIndexId: null,
        generationPendingAction: "index",
        generationPendingIndexIds: [staleIndexId],
      });

      await db
        .update(caseLawDecisions)
        .set({ indexedHash: "stale-content" })
        .where(eq(caseLawDecisions.id, decisionId));
      const stale = await caseLawCorpusIndexAdapter.selectStale(scopedDb, {
        generation,
        limit: 100,
      });
      expect(stale.find(({ id }) => id === decisionId)).toMatchObject({
        generationIndexId: null,
        generationPendingAction: "index",
        generationPendingIndexIds: [staleIndexId],
      });
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
        return indexedOutcome(rows.length);
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

      // A country from another index group: under this generation CZE and
      // SVK share one physical index, so only a different group is a
      // different index.
      await db
        .update(caseLawCorpusIndexProjections)
        .set({
          indexId: corpusIndexId(generation, "POL"),
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
          return indexedOutcome(0);
        }
        let markedCount = 0;
        await runnerDb(async (tx) => {
          await options.beforeDatabaseMark(tx);
          const marked = await caseLawCorpusIndexAdapter.markIndexedBatch(tx, {
            indexId: corpusIndexId(rebuildGeneration, row.country),
            mode: {
              generation: rebuildGeneration,
              reservations: new Map(
                rows.map((selected) => [
                  selected.id,
                  {
                    indexIds: selected.generationPendingIndexIds,
                    revision: selected.generationPendingRevision,
                    mayHaveCopy: true,
                  },
                ]),
              ),
              type: "generation-rebuild",
            },
            now: new Date("2026-07-31T13:00:00.000Z"),
            rows,
          });
          markedCount = marked.size;
        });
        return indexedOutcome(markedCount);
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
          await clearIneligibleGenerationProjection(tx, { generation, row });
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
      const projectionWhere = and(
        eq(caseLawCorpusIndexProjections.generation, generation),
        eq(caseLawCorpusIndexProjections.decisionId, restrictedId),
      );
      expect(
        (
          await db
            .select()
            .from(caseLawCorpusIndexProjections)
            .where(projectionWhere)
        ).at(0),
      ).toMatchObject({
        indexedHash: null,
        indexId: null,
        pendingAction: null,
        pendingHash: null,
        pendingIndexIds: [],
      });

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

      expect(await backfill(scopedDb, 10, generation)).toEqual({
        indexed: 1,
        status: "advanced",
      });
      expect(indexed).toEqual([restrictedId, restrictedId]);
      expect(
        (
          await db
            .select()
            .from(caseLawCorpusIndexProjections)
            .where(projectionWhere)
        ).at(0),
      ).toMatchObject({
        indexedHash: "restricted",
        indexId: corpusIndexId(generation, "CZE"),
        pendingAction: null,
      });
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
        return indexedOutcome(rows.length);
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
  expectConstraintViolation(
    rejection,
    "case_law_corpus_index_projections_pending_shape",
  );

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
  expectConstraintViolation(
    missingTarget,
    "case_law_corpus_index_projections_pending_shape",
  );

  const negativeRevision: unknown = await db
    .insert(caseLawCorpusIndexProjections)
    .values({
      decisionId: publicFirstId,
      generation,
      pendingRevision: -1,
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expectConstraintViolation(
    negativeRevision,
    "case_law_corpus_index_projections_pending_revision_nonnegative",
  );
});

test(
  "a microsecond-precision keyset drains instead of re-serving its cursor row",
  async () => {
    // Postgres timestamps carry microseconds, a JS `Date` carries
    // milliseconds. A cursor read back as a `Date` is truncated, so the page
    // predicate re-selects the row the cursor was written from and the walk
    // never empties. These fixtures share one millisecond and differ only
    // below it: the only shape that tells an exact cursor from a truncated
    // one.
    const generation = "case_law_v40";
    const microsecondFixtures = [
      "2026-07-30 21:38:52.982238+00",
      "2026-07-30 21:38:52.982239+00",
      "2026-07-30 21:38:52.982240+00",
      "2026-07-30 21:38:52.982999+00",
    ].map((createdAt, index) => ({
      createdAt,
      id: toSafeId<"caseLawDecision">(
        `00000000-0000-4000-8000-00000000040${index}`,
      ),
    }));
    const microsecondIds = microsecondFixtures.map(({ id }) => id);

    await db.insert(caseLawDecisions).values(
      microsecondFixtures.map(({ createdAt, id }, index) => ({
        caseNumber: `40 T ${index}/2026`,
        contentHash: `microsecond-${index}`,
        country: "CZE",
        court: "Microsecond court",
        createdAt: sql`${createdAt}::timestamptz`,
        decisionDate: "2026-01-01",
        fulltext: "text",
        id,
        language: "cs",
        languageGroupKey: `microsecond-${index}`,
        slug: `microsecond-${index}`,
        sourceId: publicSourceId,
      })),
    );

    try {
      // Guards the fixture itself: a millisecond-seeded row cannot reproduce
      // the defect, so the seed must survive the round trip with distinct
      // microseconds that collapse to a single millisecond.
      const precision = (
        await db
          .select({
            exact: sql<number>`count(distinct ${caseLawDecisions.createdAt})::int`,
            truncated: sql<number>`count(distinct date_trunc('milliseconds', ${caseLawDecisions.createdAt}))::int`,
          })
          .from(caseLawDecisions)
          .where(inArray(caseLawDecisions.id, microsecondIds))
      ).at(0);
      expect(precision).toEqual({
        exact: microsecondFixtures.length,
        truncated: 1,
      });

      const indexed: SafeId<"caseLawDecision">[] = [];
      const backfill = createCaseLawGenerationBackfill({
        backfillRows: async (_runnerDb, rows, _generation, options) => {
          await options.beforeRemoteEffect({
            effect: completeRemoteEffect,
            onLeaseLost: noRemoteEffectCompensation,
          });
          indexed.push(...rows.map(({ id }) => id));
          return indexedOutcome(rows.length);
        },
        newLeaseToken: () => "00000000-0000-4000-8000-000000000940",
        removeProjection: ignoreProjectionRemoval,
      });

      // One row per page, so a correct walk needs at most one drive per
      // decision plus the drive that observes the drained snapshot.
      const decisionCount = (
        await db
          .select({ value: sql<number>`count(*)::int` })
          .from(caseLawDecisions)
      ).at(0)?.value;
      if (decisionCount === undefined) {
        throw new Error("expected a decision count");
      }
      const driveLimit = decisionCount + 2;
      const driveUntilComplete = async (drives = 0): Promise<number> => {
        if (drives >= driveLimit) {
          return drives;
        }
        const { status } = await backfill(scopedDb, 1, generation);
        return status === "complete"
          ? drives + 1
          : await driveUntilComplete(drives + 1);
      };

      expect(await driveUntilComplete()).toBeLessThan(driveLimit);
      expect(await readCheckpoint(generation)).toMatchObject({
        status: "complete",
      });
      expect(indexed).toHaveLength(new Set(indexed).size);
      expect(indexed.filter((id) => microsecondIds.includes(id))).toEqual(
        microsecondIds,
      );
    } finally {
      await db
        .delete(caseLawDecisions)
        .where(inArray(caseLawDecisions.id, microsecondIds));
      await db
        .delete(caseLawCorpusIndexBackfills)
        .where(eq(caseLawCorpusIndexBackfills.generation, generation));
    }
  },
  { timeout: 30_000 },
);

test(
  "a trigger-seeded projection reserves as append-safe until a reservation crosses the boundary",
  async () => {
    // The projection trigger seeds every pending decision at revision 1 with
    // append targets, so revision alone cannot distinguish a first-ever
    // append from a replay; only the boundary stamp can. This runs the real
    // trigger and the real reservation together — the combination whose
    // absence from the suite let a revision-based gate ship and never fire.
    const generation = "case_law_v63";
    const sourceId = toSafeId<"caseLawSource">(
      "00000000-0000-4000-8000-000000000063",
    );
    const decisionId = toSafeId<"caseLawDecision">(
      "00000000-0000-4000-8000-000000000163",
    );
    // pushSchema creates tables and constraints but not migration triggers;
    // install the projection trigger so the decision insert exercises it.
    const migration = await Bun.file(generationMigrationSource).text();
    const projectionTriggerStatements = migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) =>
        statement.includes("enqueue_case_law_corpus_index_projection"),
      );
    expect(projectionTriggerStatements).toHaveLength(2);
    for (const statement of projectionTriggerStatements) {
      await db.execute(sql.raw(statement));
    }
    await db.insert(caseLawSources).values({
      adapterKey: "boundary-seed",
      id: sourceId,
      name: "boundary seed",
    });
    await db.insert(caseLawCorpusIndexBackfills).values({
      generation,
      snapshotAt: await nextBackfillSnapshotAt(),
      status: "complete",
    });
    // Inserting after the checkpoint fires the projection trigger.
    await db.insert(caseLawDecisions).values({
      caseNumber: "63 T 63/2026",
      contentHash: "boundary-seed",
      country: "CZE",
      court: "Boundary court",
      createdAt: CREATED_AT,
      fulltext: "boundary seed",
      id: decisionId,
      language: "cs",
      languageGroupKey: "boundary-seed",
      slug: "boundary-seed",
      sourceId,
    });

    try {
      const seeded = await db
        .select()
        .from(caseLawCorpusIndexProjections)
        .where(
          and(
            eq(caseLawCorpusIndexProjections.generation, generation),
            eq(caseLawCorpusIndexProjections.decisionId, decisionId),
          ),
        );
      expect(seeded).toHaveLength(1);
      expect(seeded.at(0)?.pendingRevision).toBe(1);
      expect(seeded.at(0)?.appendReservedAt).toBeNull();

      const selected = await caseLawCorpusIndexAdapter.selectMissing(scopedDb, {
        generation,
        limit: 100,
      });
      const row = selected.find(({ id }) => id === decisionId);
      expect(row).toBeDefined();
      if (!row) {
        return;
      }

      const first = await scopedDb(
        async (tx) =>
          await reserveGenerationProjectionTargets(tx, {
            generation,
            rows: [row],
          }),
      );
      // Seeded by the trigger, never appended: safe to append with no delete.
      expect(first.get(decisionId)?.mayHaveCopy).toBe(false);

      const replay = await scopedDb(
        async (tx) =>
          await reserveGenerationProjectionTargets(tx, {
            generation,
            rows: [row],
          }),
      );
      // The first reservation crossed the boundary; a replay must clean up.
      expect(replay.get(decisionId)?.mayHaveCopy).toBe(true);
    } finally {
      await db
        .delete(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId));
      await db
        .delete(caseLawCorpusIndexBackfills)
        .where(eq(caseLawCorpusIndexBackfills.generation, generation));
      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
    }
  },
  { timeout: 30_000 },
);

test(
  "an incomplete walk is driven even when nothing is pending",
  async () => {
    // The drain empties the pending queue on the same invocations that
    // advance the walk, so "checkpoint exists, nothing pending" is now the
    // steady state of a quiet corpus mid-rebuild. Routed to the incremental
    // path, the snapshot cursor would never advance again and the
    // generation would sit at `running` forever.
    const generation = "case_law_v65";
    const boundary = (
      await db
        .select({
          decisionDate: caseLawDecisions.decisionDate,
          id: caseLawDecisions.id,
        })
        .from(caseLawDecisions)
        .orderBy(sql`${WALK_DATE} DESC`, desc(caseLawDecisions.id))
        .limit(1)
    ).at(0);
    if (!boundary) {
      throw new Error("expected seeded decisions");
    }
    await db.insert(caseLawCorpusIndexBackfills).values({
      cursorId: boundary.id,
      cursorWalkDate: boundary.decisionDate ?? UNDATED_WALK_DATE,
      generation,
      snapshotAt: await nextBackfillSnapshotAt(),
      status: "running",
    });

    try {
      // The cursor already sits at the last decision, so driving the walk
      // one page observes the drained snapshot and completes. The checkpoint
      // flip is the discriminating assertion: the routing defect sends the
      // call to the incremental path, which leaves the status at `running`
      // without ever touching the walk.
      expect(await backfillCorpusIndex(scopedDb, 10, generation)).toEqual({
        indexed: 0,
        status: "complete",
      });
      expect(await readCheckpoint(generation)).toMatchObject({
        status: "complete",
      });
    } finally {
      await db
        .delete(caseLawCorpusIndexBackfills)
        .where(eq(caseLawCorpusIndexBackfills.generation, generation));
    }
  },
  { timeout: 30_000 },
);

/**
 * A walk fixture built to break a keyset: one date carried by many rows (the
 * tie group a day-granular key leaves behind), dates out of insertion order,
 * and undated rows, whose walk position is the `-infinity` band.
 */
const walkFixtureRows = (sourceId: SafeId<"caseLawSource">) =>
  [
    { date: "2026-03-04", suffix: "01" },
    { date: null, suffix: "02" },
    { date: "1994-11-30", suffix: "03" },
    { date: "2026-03-04", suffix: "04" },
    { date: "2026-03-04", suffix: "05" },
    { date: null, suffix: "06" },
    { date: "1994-11-30", suffix: "07" },
    { date: "2011-07-19", suffix: "08" },
    { date: "2026-03-04", suffix: "09" },
    { date: "1994-11-30", suffix: "10" },
  ].map(({ date, suffix }) => ({
    caseNumber: `walk ${suffix}`,
    contentHash: `walk-${suffix}`,
    country: "CZE",
    court: "Walk court",
    createdAt: CREATED_AT,
    decisionDate: date,
    id: toSafeId<"caseLawDecision">(
      `00000000-0000-4000-8000-0000000009${suffix}`,
    ),
    language: "cs",
    languageGroupKey: `walk-${suffix}`,
    slug: `walk-${suffix}`,
    sourceId,
  }));

test(
  "the walk covers its snapshot exactly once at any page size, in date order",
  async () => {
    // The rebuild's page boundaries are wherever the batch size and the
    // scheduler put them, and the cursor is all that carries the walk across
    // them. Ties and the undated band are where a keyset drops or repeats a
    // row, so the same fixture is walked at several page sizes: a page size
    // that divides the tie group and one that splits it mid-way both have to
    // reach the same set.
    const sourceId = toSafeId<"caseLawSource">(
      "00000000-0000-4000-8000-000000000901",
    );
    const rows = walkFixtureRows(sourceId);
    await db
      .insert(caseLawSources)
      .values({ adapterKey: "walk", id: sourceId, name: "walk" });
    await db.insert(caseLawDecisions).values(rows);
    const fixtureIds = new Set(rows.map((row) => row.id));

    try {
      for (const [index, batchSize] of [1, 2, 3, 7].entries()) {
        const generation = `case_law_v7${index}`;
        const seen: {
          decisionDate: string | null;
          id: SafeId<"caseLawDecision">;
        }[] = [];
        let lease = 0;
        const backfill = createCaseLawGenerationBackfill({
          backfillRows: async (_runnerDb, batch) => {
            for (const row of batch) {
              seen.push({ decisionDate: row.decisionDate, id: row.id });
            }
            return indexedOutcome(batch.length);
          },
          newLeaseToken: () =>
            `00000000-0000-4000-8000-${String(++lease).padStart(12, "0")}`,
          removeProjection: ignoreProjectionRemoval,
        });

        // Bounded so a cursor that stops advancing fails here rather than
        // hanging: every page either moves the cursor or ends the walk.
        let pages = 0;
        let status = "";
        while (status !== "complete" && pages < 200) {
          pages += 1;
          status = (await backfill(scopedDb, batchSize, generation)).status;
        }
        expect(status).toBe("complete");

        const fixtureSeen = seen.filter((row) => fixtureIds.has(row.id));
        // Exactly once: no row skipped over a page boundary, none repeated.
        expect(fixtureSeen.map((row) => row.id).sort()).toEqual(
          [...fixtureIds].sort(),
        );
        // And in the order the documents will carry: undated first, then by
        // date. Asserted over every row the walk handed out, not just the
        // fixture's, because a break in the order anywhere is a break.
        const walkKeys = seen.map((row) => ({
          date: row.decisionDate ?? "",
          id: row.id,
        }));
        const ordered = [...walkKeys].sort((left, right) => {
          if (left.date !== right.date) {
            return left.date < right.date ? -1 : 1;
          }
          if (left.id === right.id) {
            return 0;
          }
          return left.id < right.id ? -1 : 1;
        });
        expect(walkKeys).toEqual(ordered);
      }
    } finally {
      await db
        .delete(caseLawCorpusIndexBackfills)
        .where(
          inArray(caseLawCorpusIndexBackfills.generation, [
            "case_law_v70",
            "case_law_v71",
            "case_law_v72",
            "case_law_v73",
          ]),
        );
      await db
        .delete(caseLawDecisions)
        .where(inArray(caseLawDecisions.id, [...fixtureIds]));
      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
    }
  },
  { timeout: 60_000 },
);

test(
  "a corrected decision date reaches the pending queue",
  async () => {
    // The walk's position is the decision date, so a correction to it can move
    // a row behind the cursor, out of the range the walk has left. Nothing
    // else would notice: the text is unchanged, so the content hash is too.
    const generation = "case_law_v74";
    const sourceId = toSafeId<"caseLawSource">(
      "00000000-0000-4000-8000-000000000902",
    );
    const decisionId = toSafeId<"caseLawDecision">(
      "00000000-0000-4000-8000-000000000903",
    );
    await db
      .insert(caseLawSources)
      .values({ adapterKey: "redate", id: sourceId, name: "redate" });
    await db.insert(caseLawCorpusIndexBackfills).values({
      generation,
      snapshotAt: await nextBackfillSnapshotAt(),
      status: "running",
    });

    try {
      await installProjectionTrigger();
      await db.insert(caseLawDecisions).values({
        caseNumber: "74 T 74/2026",
        contentHash: "redate",
        country: "CZE",
        court: "Redate court",
        createdAt: CREATED_AT,
        decisionDate: "2026-02-02",
        id: decisionId,
        indexedGeneration: corpusIndexId(generation, "CZE"),
        indexedHash: "redate",
        language: "cs",
        languageGroupKey: "redate",
        slug: "redate",
        sourceId,
      });
      // The insert enqueues; clearing that is what makes the update the only
      // thing the assertion can be reading.
      await db
        .delete(caseLawCorpusIndexProjections)
        .where(eq(caseLawCorpusIndexProjections.decisionId, decisionId));

      await db
        .update(caseLawDecisions)
        .set({ decisionDate: "1998-05-06" })
        .where(eq(caseLawDecisions.id, decisionId));

      expect(
        await db
          .select({
            pendingAction: caseLawCorpusIndexProjections.pendingAction,
            pendingHash: caseLawCorpusIndexProjections.pendingHash,
          })
          .from(caseLawCorpusIndexProjections)
          .where(eq(caseLawCorpusIndexProjections.decisionId, decisionId)),
      ).toEqual([{ pendingAction: "index", pendingHash: "redate" }]);
    } finally {
      await db
        .delete(caseLawCorpusIndexProjections)
        .where(eq(caseLawCorpusIndexProjections.decisionId, decisionId));
      await db
        .delete(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId));
      await db
        .delete(caseLawCorpusIndexBackfills)
        .where(eq(caseLawCorpusIndexBackfills.generation, generation));
      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
    }
  },
  { timeout: 30_000 },
);

test(
  "drains pending projections while the generation is still running",
  async () => {
    // The wedge this guards: with the drain tied to a completed walk, a
    // generation stuck at `running` silently stopped indexing every newly
    // ingested decision. The pending queue must drain on the same invocation
    // that advances the walk, before the walk, and without completing it.
    const generation = "case_law_v64";
    await db.insert(caseLawCorpusIndexBackfills).values({
      generation,
      snapshotAt: await nextBackfillSnapshotAt(),
      status: "running",
    });
    await db.insert(caseLawCorpusIndexProjections).values({
      decisionId: publicLastId,
      generation,
      pendingAction: "index",
      pendingHash: "last",
      pendingIndexIds: [corpusIndexId(generation, "CZE")],
    });

    const sent: SafeId<"caseLawDecision">[][] = [];
    const commits: CorpusIndexCommitMode[] = [];
    const backfill = createCaseLawGenerationBackfill({
      backfillRows: async (runnerDb, rows, rebuildGeneration, options) => {
        await options.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: noRemoteEffectCompensation,
        });
        sent.push(rows.map((row) => row.id));
        commits.push(options.commit);
        await runnerDb(async (tx) => {
          await options.beforeDatabaseMark(tx);
          await tx
            .delete(caseLawCorpusIndexProjections)
            .where(
              eq(caseLawCorpusIndexProjections.generation, rebuildGeneration),
            );
        });
        return indexedOutcome(rows.length);
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000640",
      removeProjection: ignoreProjectionRemoval,
    });

    try {
      // batchSize 1 leaves the walk pages away from its snapshot end, so the
      // generation stays running; the queued row must index anyway, first.
      expect(await backfill(scopedDb, 1, generation)).toEqual({
        indexed: 2,
        status: "advanced",
      });
      expect(sent.at(0)).toEqual([publicLastId]);
      // A running generation's census is the backstop for the drain as much
      // as for the walk, so neither page waits for the engine's commit.
      expect(commits).toEqual([
        CORPUS_INDEX_COMMIT.auto,
        CORPUS_INDEX_COMMIT.auto,
      ]);
      expect(await readCheckpoint(generation)).toMatchObject({
        leaseExpiresAt: null,
        leaseToken: null,
        status: "running",
      });
      expect(
        await db
          .select()
          .from(caseLawCorpusIndexProjections)
          .where(eq(caseLawCorpusIndexProjections.generation, generation)),
      ).toHaveLength(0);
    } finally {
      await db
        .delete(caseLawCorpusIndexProjections)
        .where(eq(caseLawCorpusIndexProjections.generation, generation));
      await db
        .delete(caseLawCorpusIndexBackfills)
        .where(eq(caseLawCorpusIndexBackfills.generation, generation));
    }
  },
  { timeout: 30_000 },
);
