/**
 * The guarded flip's fenced phase against real PostgreSQL locks: a canonical
 * writer holding its source lock holds back the flip before the flip takes
 * any registry row lock, so the writer's later key-share lock on the
 * generation row (the projection foreign keys take it) cannot close a
 * deadlock cycle; and a writer that holds on past the flip's lock timeout
 * gets the flip refused as busy instead of a flip that waits.
 */

import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { waitForExternalState } from "@stll/property-testing/external-state";

import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
} from "@/api/db/schema";
import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  type CorpusIndexFlipPlan,
  runCorpusIndexGenerationFlip,
} from "@/api/lib/legal-search/corpus-index-generation-flip";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { lockActiveCorpusProjectionSourceTx } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { lockCorpusIndexProjectionWriterTx } from "@/api/lib/legal-search/corpus-index-projection-revision";
import { isRecord } from "@/api/lib/type-guards";
import {
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

/** A manifest generation no other gated suite registers. */
const MANIFEST = CORPUS_INDEX_MANIFESTS.case_law_v7;
const TARGET = { family: "case_law", generation: "case_law_v7" } as const;
const LOCK_WAIT_POLL_MS = 20;

type RelationLock = { relation: string; mode: string; granted: boolean };

const relationLocksOf = async (
  db: GatedTestDb,
  pid: number,
): Promise<RelationLock[]> =>
  executedRows(
    await db.execute(sql`
      SELECT relation::regclass::text AS relation, mode, granted
      FROM pg_catalog.pg_locks
      WHERE pid = ${pid} AND locktype = 'relation'
    `),
  ).map((row) =>
    isRecord(row) &&
    typeof row["relation"] === "string" &&
    typeof row["mode"] === "string" &&
    typeof row["granted"] === "boolean"
      ? {
          relation: row["relation"],
          mode: row["mode"],
          granted: row["granted"],
        }
      : panic("pg_locks returned a malformed row"),
  );

/** Resolves with the backend's locks once it waits on `relation`. */
const waitingOn = async (
  db: GatedTestDb,
  pid: number,
  relation: string,
): Promise<RelationLock[]> =>
  await waitForExternalState({
    description: `backend ${String(pid)} waits on ${relation}`,
    intervalMs: LOCK_WAIT_POLL_MS,
    read: async () => {
      const locks = await relationLocksOf(db, pid);
      return (
        locks.some((lock) => lock.relation === relation && !lock.granted) &&
        locks
      );
    },
  });

/**
 * A plan whose candidate identity no registry row has: the fenced phase takes
 * its locks, re-reads the pair and refuses `generation_changed`, so the test
 * exercises the locks and never flips the shared database's registry.
 */
const stalePlan = (): Extract<CorpusIndexFlipPlan, { type: "flip" }> => ({
  type: "flip",
  request: {
    family: TARGET.family,
    candidate: TARGET.generation,
    replacing: { type: "unchecked" },
    exemptMinutes: 20,
    coverage: { pageSize: 1000, pageBudget: 1 },
    maxProofAgeHours: 24,
  },
  candidate: { generation: TARGET.generation, updatedAtUs: "0" },
  serving: null,
  proofs: [],
  documents: [],
  walk: null,
});

const refusalOf = (
  outcome: Awaited<ReturnType<typeof runCorpusIndexGenerationFlip>>,
) =>
  outcome.isErr()
    ? `${outcome.error.refusal.class}:${outcome.error.refusal.reason}`
    : "none";

type Fixture = {
  writerDb: GatedTestDb;
  flipDb: GatedTestDb;
  observerDb: GatedTestDb;
  subject: { family: "case_law"; entityId: SafeId<"caseLawDecision"> };
};

/** A source, a decision and a building registration no other suite uses. */
const withFixture = async (run: (fixture: Fixture) => Promise<void>) => {
  if (databaseUrl === undefined) {
    panic("DATABASE_URL is required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const { db: writerDb } = openClient();
    const { db: flipDb } = openClient();
    const { db: observerDb } = openClient();
    const suffix = Date.now();
    const sourceId = toSafeId<"caseLawSource">(Bun.randomUUIDv7());
    const decisionId = toSafeId<"caseLawDecision">(Bun.randomUUIDv7());
    const target = and(
      eq(corpusIndexGenerations.family, TARGET.family),
      eq(corpusIndexGenerations.generation, TARGET.generation),
    );
    try {
      expect(
        await writerDb
          .select({ generation: corpusIndexGenerations.generation })
          .from(corpusIndexGenerations)
          .where(target),
      ).toEqual([]);
      await writerDb.insert(caseLawSources).values({
        id: sourceId,
        adapterKey: `generation-flip-lock-order-${suffix}`,
        name: "Generation flip lock order",
      });
      await writerDb.insert(caseLawDecisions).values({
        id: decisionId,
        sourceId,
        caseNumber: `generation-flip-lock-order-${suffix}`,
        court: "Generation flip court",
        country: "CZE",
        language: "cs",
        contentHash: "a".repeat(64),
      });
      await writerDb.insert(corpusIndexGenerations).values({
        ...TARGET,
        cluster: MANIFEST.cluster,
        manifestDigest: corpusIndexManifestDigest(MANIFEST),
        status: "building",
      });
      await run({
        writerDb,
        flipDb,
        observerDb,
        subject: { family: "case_law", entityId: decisionId },
      });
    } finally {
      await writerDb
        .update(corpusIndexGenerations)
        .set({ status: "retired" })
        .where(target);
      await writerDb.delete(corpusIndexGenerations).where(target);
      await writerDb
        .delete(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId));
      await writerDb
        .delete(caseLawSources)
        .where(eq(caseLawSources.id, sourceId));
    }
  });
};

/** Runs the fenced phase on `db`, resolving its backend pid first. */
const startFlip = async (db: GatedTestDb, pid: PromiseWithResolvers<number>) =>
  await runCorpusIndexGenerationFlip(
    async (work) =>
      await db.transaction(async (tx) => {
        const row = executedRows(
          await tx.execute(sql`SELECT pg_backend_pid() AS pid`),
        ).at(0);
        pid.resolve(
          isRecord(row) && typeof row["pid"] === "number"
            ? row["pid"]
            : panic("pg_backend_pid returned a malformed row"),
        );
        return await work(tx);
      }),
    stalePlan(),
    { mode: "dry_run" },
  );

if (!databaseUrl || !runPostgresTests) {
  describe.skip("corpus generation flip locks (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("corpus generation flip locks (postgres)", () => {
    test("a canonical writer holds back the fenced phase before any registry row lock, and both finish", async () => {
      await withFixture(async ({ writerDb, flipDb, observerDb, subject }) => {
        const writerLocked = Promise.withResolvers<undefined>();
        const releaseWriter = Promise.withResolvers<undefined>();
        const flipPid = Promise.withResolvers<number>();
        // The canonical order: source share lock, the shared side of the
        // projection fence, then a key-share lock on the generation row.
        const writer = writerDb.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
          expect(
            await lockActiveCorpusProjectionSourceTx(tx, subject),
          ).not.toBeNull();
          writerLocked.resolve(undefined);
          await releaseWriter.promise;
          await lockCorpusIndexProjectionWriterTx(tx);
          await tx
            .select({ generation: corpusIndexGenerations.generation })
            .from(corpusIndexGenerations)
            .where(
              and(
                eq(corpusIndexGenerations.family, TARGET.family),
                eq(corpusIndexGenerations.generation, TARGET.generation),
              ),
            )
            .for("key share");
        });
        await writerLocked.promise;
        const flip = startFlip(flipDb, flipPid);
        const locks = await waitingOn(
          observerDb,
          await flipPid.promise,
          "case_law_sources",
        );
        expect(locks).toContainEqual({
          relation: "case_law_sources",
          mode: "ExclusiveLock",
          granted: false,
        });
        // A registry row lock shows as a relation lock on the registry.
        expect(
          locks.filter(
            ({ relation }) => relation === "corpus_index_generations",
          ),
        ).toEqual([]);
        releaseWriter.resolve(undefined);
        await writer;
        // Its locks taken, the fenced phase re-reads the pair and refuses the
        // stale plan: no deadlock, nothing written.
        expect(refusalOf(await flip)).toBe("registry:generation_changed");
      });
    });

    test("a writer that holds its source lock past the lock timeout gets a busy refusal, not a wait", async () => {
      await withFixture(async ({ writerDb, flipDb, subject }) => {
        const writerLocked = Promise.withResolvers<undefined>();
        const releaseWriter = Promise.withResolvers<undefined>();
        const writer = writerDb.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
          expect(
            await lockActiveCorpusProjectionSourceTx(tx, subject),
          ).not.toBeNull();
          writerLocked.resolve(undefined);
          await releaseWriter.promise;
        });
        await writerLocked.promise;
        // The writer is released only after the flip returns, so a flip that
        // waited for it would never return: the refusal is the proof.
        const flip = await startFlip(flipDb, Promise.withResolvers<number>());
        releaseWriter.resolve(undefined);
        await writer;
        expect(refusalOf(flip)).toBe("busy:lock_unavailable");
      });
    });
  });
}
