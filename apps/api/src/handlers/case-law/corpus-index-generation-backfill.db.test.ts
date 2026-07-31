import { afterAll, beforeAll, expect, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api-postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as authSchema from "@/api/db/auth-schema";
import * as rlsExports from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import * as schema from "@/api/db/schema";
import {
  caseLawCorpusIndexBackfills,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import {
  caseLawCorpusIndexAdapter,
  createCaseLawGenerationBackfill,
} from "@/api/handlers/case-law/corpus-index";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import {
  createSchemaPglite,
  installPgliteSchemaPrerequisites,
} from "@/api/tests/pglite-schema";

const allSchema = { ...schema, ...authSchema, ...rlsExports };
const CREATED_AT = new Date("2026-07-30T12:00:00.000Z");
const GENERATION = "case_law_v2";

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
    return await callback(tx as unknown as Transaction);
  });

const readCheckpoint = async (generation: string) =>
  (
    await db
      .select()
      .from(caseLawCorpusIndexBackfills)
      .where(eq(caseLawCorpusIndexBackfills.generation, generation))
      .limit(1)
  ).at(0);

test(
  "replays the snapshot once and reconciles pending rows after completion",
  async () => {
    const sent: SafeId<"caseLawDecision">[][] = [];
    let guardedPages = 0;
    let pendingCalls = 0;
    let pendingPages = 1;
    let lease = 0;
    const backfill = createCaseLawGenerationBackfill({
      backfillIncremental: async () => {
        pendingCalls += 1;
        const indexed = pendingPages;
        pendingPages = 0;
        return indexed;
      },
      backfillRows: async (_scopedDb, rows, _generation, options) => {
        await options.beforeRemoteEffect();
        sent.push(rows.map((row) => row.id));
        guardedPages += 1;
        return rows.length;
      },
      newLeaseToken: () =>
        `00000000-0000-4000-8000-${String(++lease).padStart(12, "0")}`,
    });

    expect(await backfill(scopedDb, 2, GENERATION)).toMatchObject({
      indexed: 1,
      status: "advanced",
    });
    expect(await backfill(scopedDb, 2, GENERATION)).toMatchObject({
      indexed: 1,
      status: "advanced",
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
    expect(sent).toEqual([[publicFirstId], [publicLastId]]);
    expect(guardedPages).toBe(2);
    expect(pendingCalls).toBe(3);
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
  "holds the full cursor on failure and lets only one runner own external index writes",
  async () => {
    const retryGeneration = "case_law_v2_retry";
    let releaseFirstPage: (() => void) | undefined;
    let firstPageStarted: (() => void) | undefined;
    const firstPageStartedPromise = new Promise<void>((resolve) => {
      firstPageStarted = resolve;
    });
    const firstPageReleasePromise = new Promise<void>((resolve) => {
      releaseFirstPage = resolve;
    });
    const backfill = createCaseLawGenerationBackfill({
      backfillIncremental: async () => 0,
      backfillRows: async (_scopedDb, _rows, _generation, options) => {
        await options.beforeRemoteEffect();
        firstPageStarted?.();
        await firstPageReleasePromise;
        throw new Error("search unavailable");
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000100",
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
      backfillIncremental: async () => 0,
      backfillRows: async (_scopedDb, _rows, _generation, options) => {
        await options.beforeRemoteEffect();
        return 0;
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000101",
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
      backfillIncremental: async () => 0,
      backfillRows: async (_scopedDb, rows, _generation, options) => {
        await options.beforeRemoteEffect();
        replayed.push(rows.map((row) => row.id));
        return rows.length;
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000102",
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
    const generation = "case_law_v2_takeover";
    let winningRemoteEffects = 0;
    const winner = createCaseLawGenerationBackfill({
      backfillIncremental: async () => 0,
      backfillRows: async (_scopedDb, rows, _generation, options) => {
        await options.beforeRemoteEffect();
        winningRemoteEffects += 1;
        return rows.length;
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000201",
    });

    let staleRemoteEffects = 0;
    let winnerResult: Awaited<ReturnType<typeof winner>> | undefined;
    const stale = createCaseLawGenerationBackfill({
      backfillIncremental: async () => 0,
      backfillRows: async (_scopedDb, rows, _generation, options) => {
        await db
          .update(caseLawCorpusIndexBackfills)
          .set({ leaseExpiresAt: new Date("2000-01-01T00:00:00.000Z") })
          .where(eq(caseLawCorpusIndexBackfills.generation, generation));
        winnerResult = await winner(scopedDb, 1, generation);
        await options.beforeRemoteEffect();
        staleRemoteEffects += 1;
        return rows.length;
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000200",
    });

    const rejection: unknown = await stale(scopedDb, 1, generation).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: "Case-law corpus generation lease was lost",
    });
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
  "an owner that expires after ingest cannot commit the database mark",
  async () => {
    const generation = "case_law_v2_mark_fence";
    let winningRemoteEffects = 0;
    const winner = createCaseLawGenerationBackfill({
      backfillIncremental: async () => 0,
      backfillRows: async (runnerDb, rows, _generation, options) => {
        await options.beforeRemoteEffect();
        winningRemoteEffects += 1;
        await runnerDb(options.beforeDatabaseMark);
        return rows.length;
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000401",
    });

    let staleDatabaseMarks = 0;
    let staleRemoteEffects = 0;
    let winnerResult: Awaited<ReturnType<typeof winner>> | undefined;
    const stale = createCaseLawGenerationBackfill({
      backfillIncremental: async () => 0,
      backfillRows: async (runnerDb, rows, _generation, options) => {
        await options.beforeRemoteEffect();
        staleRemoteEffects += 1;
        await db
          .update(caseLawCorpusIndexBackfills)
          .set({ leaseExpiresAt: new Date("2000-01-01T00:00:00.000Z") })
          .where(eq(caseLawCorpusIndexBackfills.generation, generation));
        winnerResult = await winner(scopedDb, 1, generation);
        await runnerDb(options.beforeDatabaseMark);
        staleDatabaseMarks += 1;
        return rows.length;
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000400",
    });

    const rejection: unknown = await stale(scopedDb, 1, generation).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: "Case-law corpus generation lease was lost",
    });
    expect(winnerResult).toMatchObject({ indexed: 1, status: "advanced" });
    expect(winningRemoteEffects).toBe(1);
    expect(staleRemoteEffects).toBe(1);
    expect(staleDatabaseMarks).toBe(0);
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
    const generation = "case_law_v2_refreshed";
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
      backfillIncremental: async () => 0,
      backfillRows: async (_scopedDb, rows, _generation, options) => {
        await options.beforeRemoteEffect();
        sent.push(...rows.map(({ id }) => id));
        return rows.length;
      },
      newLeaseToken: () => "00000000-0000-4000-8000-000000000300",
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
