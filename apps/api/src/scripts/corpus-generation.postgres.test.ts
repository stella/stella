/**
 * The guarded flip against real PostgreSQL. A whole `serve --apply` through
 * the operator command's own database door (its read-only session, then the
 * bounded maintenance lane on its own connection, as the login the API
 * deploys with: the tables' owner, not a superuser, so the receipt's forced
 * row security applies): every fenced read, the swap, the receipt INSERT with
 * its database-computed digest, and the audit run. Then the fenced phase's
 * locks: a canonical writer holding its source lock holds back the flip
 * before the flip takes any registry row lock, so the writer's later
 * key-share lock on the generation row (the projection foreign keys take it)
 * cannot close a deadlock cycle; and a writer that holds on past the flip's
 * lock timeout gets the flip refused as busy instead of a flip that waits.
 * And `seed` beside writers holding a source row its next page reads: a
 * plain update of the row (ingestion bookkeeping) does not hold the page
 * back at all; under a fence that locks the row for update the page loses
 * its lock wait and rolls back, the run walks it again once the fence lets
 * go, and stops as busy (exit 7) with nothing of the refused page written
 * when the fence holds on past the run's patience.
 *
 * The suite registers a serving generation, so it runs alone on a fresh
 * clone (`EXCLUSIVE_SHARED_TABLE_DDL_TEST_PATHS`).
 */

import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import { compareCodeUnit } from "@stll/collation";
import { waitForExternalState } from "@stll/property-testing/external-state";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexGenerationSeedingPasses,
  databaseBackfillStates,
} from "@/api/db/schema";
import { loadGateHealthConfig } from "@/api/env-online-index";
import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
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
import { runCorpusGenerationCommand } from "@/api/scripts/corpus-generation";
import {
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import {
  createCorpusFlipFixture,
  FLIP_V7,
  FLIP_V10,
} from "@/api/tests/helpers/corpus-flip-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

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

/** The seed pages' lock timeout: short, so a lost lock wait comes fast. */
const SEED_LOCK_TIMEOUT_MS = 200;
const SEED_CHECKPOINT = `corpus-seeding:${TARGET.family}:${TARGET.generation}`;
const LOCK_WAIT_LINE = "a page waits on a lock on case_law_sources";

type SeedFixture = {
  db: GatedTestDb;
  writerDb: GatedTestDb;
  /** The first decision's source, which no writer holds. */
  free: SafeId<"caseLawDecision">;
  /** The later decision's source, whose row the writer locks. */
  heldSource: string;
};

/**
 * Two decisions, each of its own source, in id order, and a building
 * registration. Their text has not settled, so the walk passes them without
 * writing a state, but every page still share-locks its rows' source policy.
 */
const withSeedFixture = async (
  run: (fixture: SeedFixture) => Promise<void>,
) => {
  if (databaseUrl === undefined) {
    panic("DATABASE_URL is required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const { db } = openClient();
    const { db: writerDb } = openClient();
    const suffix = Bun.randomUUIDv7();
    const sourceIds = [Bun.randomUUIDv7(), Bun.randomUUIDv7()].map((id) =>
      toSafeId<"caseLawSource">(id),
    );
    // In id order: the walk reaches the free decision's page first.
    const decisionIds = [Bun.randomUUIDv7(), Bun.randomUUIDv7()]
      .toSorted(compareCodeUnit)
      .map((id) => toSafeId<"caseLawDecision">(id));
    const target = and(
      eq(corpusIndexGenerations.family, TARGET.family),
      eq(corpusIndexGenerations.generation, TARGET.generation),
    );
    const heldSource =
      sourceIds.at(1) ?? panic("the seed fixture needs two sources");
    const free =
      decisionIds.at(0) ?? panic("the seed fixture needs two decisions");
    try {
      expect(
        await db
          .select({ generation: corpusIndexGenerations.generation })
          .from(corpusIndexGenerations)
          .where(target),
      ).toEqual([]);
      await db.insert(caseLawSources).values(
        sourceIds.map((id, n) => ({
          id,
          adapterKey: `seed-lock-wait-${String(n)}-${suffix}`,
          name: "Seed lock wait",
        })),
      );
      await db.insert(caseLawDecisions).values(
        decisionIds.map((id, n) => ({
          id,
          sourceId: sourceIds[n] ?? panic("no source for the decision"),
          caseNumber: `seed-lock-wait-${String(n)}-${suffix}`,
          court: "Seed lock wait court",
          country: "CZE",
          language: "cs",
          corpusMirrorStatus: "pending" as const,
        })),
      );
      await db.insert(corpusIndexGenerations).values({
        ...TARGET,
        cluster: MANIFEST.cluster,
        manifestDigest: corpusIndexManifestDigest(MANIFEST),
        status: "building",
      });
      await run({
        db,
        writerDb,
        free,
        heldSource,
      });
    } finally {
      // Leaving the active set deletes the pass and its route rows.
      await db
        .update(corpusIndexGenerations)
        .set({ status: "retired" })
        .where(target);
      await db.delete(corpusIndexGenerations).where(target);
      await db
        .delete(databaseBackfillStates)
        .where(eq(databaseBackfillStates.name, SEED_CHECKPOINT));
      await db
        .delete(caseLawDecisions)
        .where(inArray(caseLawDecisions.id, decisionIds));
      await db
        .delete(caseLawSources)
        .where(inArray(caseLawSources.id, sourceIds));
    }
  });
};

/** `seed` through the command, on `db`, one decision per page. */
const runSeed = async (
  db: GatedTestDb,
  {
    maxLockWaitMs,
    onLine = () => {},
  }: {
    maxLockWaitMs: number;
    onLine?: (line: string) => void;
  },
) => {
  const out: string[] = [];
  const rootDb = asTestRaw<CaseLawRootHandle>({
    transaction: async <T>(fn: (tx: Transaction) => Promise<T>) =>
      await db.transaction(async (tx) => await fn(asTestRaw<Transaction>(tx))),
    execute: async (query: Parameters<typeof db.execute>[0]) =>
      await db.execute(query),
  });
  const code = await runCorpusGenerationCommand({
    args: [
      "seed",
      "--family",
      TARGET.family,
      "--generation",
      TARGET.generation,
    ],
    withSeedingDatabase: async (work) => await work(rootDb),
    seedingBrake: {
      createRuntime: (options) =>
        createScriptBackfillRuntime({
          ...options,
          initialSize: 1,
          config: {
            ...loadGateHealthConfig(),
            minSize: 1,
            maxSize: 1,
            batchLockTimeoutMs: SEED_LOCK_TIMEOUT_MS,
          },
          readVerdict: async () => ({ kind: "normal", signals: [] }),
          // The load brake is not under test; the shared slot is not either.
          slot: { tryAcquire: async () => true, release: () => {} },
        }),
      maxWaitMs: 0,
      maxLockWaitMs,
    },
    write: (line) => {
      out.push(line);
      onLine(line);
    },
    writeError: (line) => {
      out.push(line);
    },
  });
  return { code, out: out.join("\n") };
};

/**
 * Holds `sourceId`'s row until released: `fence` locks it for update, as a
 * writer that fences a source does; `update` changes a bookkeeping column, as
 * an ingestion run does with its lease, observation order or checkpoint.
 */
const holdSource = async (
  writerDb: GatedTestDb,
  sourceId: string,
  how: "fence" | "update",
) => {
  const locked = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const source = eq(caseLawSources.id, toSafeId<"caseLawSource">(sourceId));
  const writer = writerDb.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    if (how === "fence") {
      await tx
        .select({ id: caseLawSources.id })
        .from(caseLawSources)
        .where(source)
        .for("update");
    } else {
      await tx
        .update(caseLawSources)
        .set({ observationOrder: sql`${caseLawSources.observationOrder} + 1` })
        .where(source);
    }
    locked.resolve(undefined);
    await release.promise;
  });
  await locked.promise;
  return {
    release: async () => {
      release.resolve(undefined);
      await writer;
    },
  };
};

/** `seed` while a writer holds `sourceId`'s row, released once the run returns. */
const runSeedWhileHeld = async (
  { db, writerDb }: Pick<SeedFixture, "db" | "writerDb">,
  {
    sourceId,
    how,
    maxLockWaitMs,
  }: {
    sourceId: string;
    how: "fence" | "update";
    maxLockWaitMs: number;
  },
) => {
  const writer = await holdSource(writerDb, sourceId, how);
  try {
    return await runSeed(db, { maxLockWaitMs });
  } finally {
    await writer.release();
  }
};

const seedingPassOf = async (db: GatedTestDb) =>
  await db
    .select({
      afterEntityId: corpusIndexGenerationSeedingPasses.afterEntityId,
      completedAt: corpusIndexGenerationSeedingPasses.completedAt,
    })
    .from(corpusIndexGenerationSeedingPasses)
    .where(
      and(
        eq(corpusIndexGenerationSeedingPasses.family, TARGET.family),
        eq(corpusIndexGenerationSeedingPasses.generation, TARGET.generation),
      ),
    );

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

    test("seed does not wait on a writer that updates a source row its page reads", async () => {
      await withSeedFixture(async ({ db, writerDb, heldSource }) => {
        // No patience at all: a page that lost even one lock wait would stop
        // the run as busy, and the writer holds on until the run returns.
        const seeded = await runSeedWhileHeld(
          { db, writerDb },
          { sourceId: heldSource, how: "update", maxLockWaitMs: 0 },
        );
        expect(seeded.out).not.toContain(LOCK_WAIT_LINE);
        expect(seeded.code).toBe(0);
        const [pass] = await seedingPassOf(db);
        expect(pass?.completedAt).not.toBeNull();
      });
    });

    test("seed walks a page again once the writer fencing its source lets go, and finishes", async () => {
      await withSeedFixture(async ({ db, writerDb, heldSource }) => {
        const writer = await holdSource(writerDb, heldSource, "fence");
        // Released only once the run says its page lost a lock wait, so a
        // run that crashed or stopped instead would never see it released.
        const released: { done: Promise<void> | null } = { done: null };
        const seeded = await runSeed(db, {
          maxLockWaitMs: 60_000,
          onLine: (line) => {
            if (line.startsWith(LOCK_WAIT_LINE)) {
              released.done ??= writer.release();
            }
          },
        });
        await (released.done ?? writer.release());
        expect(seeded.out).toContain(LOCK_WAIT_LINE);
        expect(seeded.out).toContain("every route of the generation is seeded");
        expect(seeded.code).toBe(0);
        const [pass] = await seedingPassOf(db);
        expect(pass?.completedAt).not.toBeNull();
      });
    });

    test("seed stops as busy (exit 7) when the fence holds on past its patience, keeps the pages before, and a rerun finishes", async () => {
      await withSeedFixture(async ({ db, writerDb, free, heldSource }) => {
        const stopped = await runSeedWhileHeld(
          { db, writerDb },
          { sourceId: heldSource, how: "fence", maxLockWaitMs: 1500 },
        );
        expect(stopped.out).toContain(LOCK_WAIT_LINE);
        expect(stopped.out).toContain(
          "a lock on case_law_sources stayed held by a writer",
        );
        expect(stopped.code).toBe(7);
        // The page before the held one committed; the refused page wrote
        // nothing: neither the pass nor the page runtime's cursor moved past.
        expect(await seedingPassOf(db)).toEqual([
          { afterEntityId: free, completedAt: null },
        ]);
        expect(
          await db
            .select({ cursor: databaseBackfillStates.cursor })
            .from(databaseBackfillStates)
            .where(eq(databaseBackfillStates.name, SEED_CHECKPOINT)),
        ).toEqual([{ cursor: free }]);

        const resumed = await runSeed(db, { maxLockWaitMs: 1500 });
        expect(resumed.out).not.toContain(LOCK_WAIT_LINE);
        expect(resumed.code).toBe(0);
        const [pass] = await seedingPassOf(db);
        expect(pass?.completedAt).not.toBeNull();
      });
    });

    test("serve --apply flips on the operator's own connection and role, with a receipt the database can recompute", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const pair = inArray(corpusIndexGenerations.generation, [
          FLIP_V7,
          FLIP_V10,
        ]);
        expect(
          await db
            .select({ generation: corpusIndexGenerations.generation })
            .from(corpusIndexGenerations)
            .where(eq(corpusIndexGenerations.family, "case_law")),
        ).toEqual([]);
        // The login every connection of this suite uses, the operator's
        // included: it owns the receipts and is no superuser, so forced row
        // security binds it.
        expect(
          executedRows(
            await db.execute(sql`
              SELECT role.rolsuper AS superuser, role.rolbypassrls AS bypass,
                flips.relforcerowsecurity AS forced,
                pg_catalog.pg_get_userbyid(flips.relowner) = current_user AS owner
              FROM pg_catalog.pg_class flips, pg_catalog.pg_roles role
              WHERE flips.oid = 'public.corpus_index_generation_flips'::regclass
                AND role.rolname = current_user
            `),
          ),
        ).toEqual([
          { superuser: false, bypass: false, forced: true, owner: true },
        ]);
        const fixture = createCorpusFlipFixture(
          async (work) =>
            await db.transaction(
              async (tx) => await work(asTestRaw<Transaction>(tx)),
            ),
        );
        // The suite runs alone on a fresh clone and this test runs last, so
        // the pair it registers and flips is left as it ends.
        await fixture.readyPair();
        const out: string[] = [];
        const err: string[] = [];
        const code = await runCorpusGenerationCommand({
          args: [
            "serve",
            "--family",
            "case_law",
            "--generation",
            FLIP_V10,
            "--apply",
            "--replacing",
            FLIP_V7,
            "--actor",
            "operator:postgres-test",
            "--reason",
            "flip under the operator role",
          ],
          indexClient: () => fixture.engineClient,
          searchEndpoint: () => "http://corpus-index.test",
          write: (line) => {
            out.push(line);
          },
          writeError: (line) => {
            err.push(line);
          },
        });
        expect({ code, err }).toEqual({ code: 0, err: [] });
        expect(out.join("\n")).toContain(
          "Applied: case_law/case_law_v10 serves; case_law_v7 is building",
        );
        expect(
          await db
            .select({
              generation: corpusIndexGenerations.generation,
              status: corpusIndexGenerations.status,
            })
            .from(corpusIndexGenerations)
            .where(pair)
            .orderBy(corpusIndexGenerations.generation),
        ).toEqual([
          { generation: FLIP_V10, status: "serving" },
          { generation: FLIP_V7, status: "building" },
        ]);
        expect(
          executedRows(
            await db.execute(sql`
                SELECT actor, evidence_digest = encode(sha256(convert_to(jsonb_build_object(
                    'family', family, 'from', from_generation, 'to', to_generation,
                    'actor', actor, 'reason', reason,
                    'flippedAtUs', (extract(epoch FROM flipped_at) * 1000000)::bigint,
                    'evidence', evidence)::text, 'UTF8')), 'hex') AS reproducible,
                  evidence -> 'parity' -> 'behindCursor' ->> 'type' AS behind_cursor
                FROM corpus_index_generation_flips
              `),
          ),
        ).toEqual([
          {
            actor: "operator:postgres-test",
            reproducible: true,
            behind_cursor: "read",
          },
        ]);
      });
    });
  });
}
