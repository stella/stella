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
import { createCaseLawGenerationBackfill } from "@/api/handlers/case-law/corpus-index";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createSchemaPglite,
  installPgliteSchemaPrerequisites,
} from "@/api/tests/pglite-schema";

const allSchema = { ...schema, ...authSchema, ...rlsExports };
const SNAPSHOT_AT = new Date("2026-07-31T12:00:00.000Z");
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

// eslint-disable-next-line arrow-body-style -- block body holds the safety rationale at the assertion boundary
const scopedDb = async <T>(callback: (tx: Transaction) => Promise<T>) => {
  // SAFETY: the runner only uses the transaction's Drizzle query surface;
  // PGlite provides that surface structurally, as in other corpus DB tests.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return await callback(db as unknown as Transaction);
};

const readCheckpoint = async (generation: string) =>
  (
    await db
      .select()
      .from(caseLawCorpusIndexBackfills)
      .where(eq(caseLawCorpusIndexBackfills.generation, generation))
      .limit(1)
  ).at(0);

test(
  "replays every snapshot row once, including equal timestamps, without indexing restricted content",
  async () => {
    const sent: SafeId<"caseLawDecision">[][] = [];
    const replaceExistingInGeneration: boolean[] = [];
    let lease = 0;
    const backfill = createCaseLawGenerationBackfill({
      backfillRows: async (_scopedDb, rows, _generation, options) => {
        sent.push(rows.map((row) => row.id));
        replaceExistingInGeneration.push(options.replaceExistingInGeneration);
        return rows.length;
      },
      clock: () => SNAPSHOT_AT,
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
    expect(replaceExistingInGeneration).toEqual([true, true]);
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
      backfillRows: async () => {
        firstPageStarted?.();
        await firstPageReleasePromise;
        throw new Error("search unavailable");
      },
      clock: () => SNAPSHOT_AT,
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
      backfillRows: async () => 0,
      clock: () => SNAPSHOT_AT,
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
      backfillRows: async (_scopedDb, rows) => {
        replayed.push(rows.map((row) => row.id));
        return rows.length;
      },
      clock: () => SNAPSHOT_AT,
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
