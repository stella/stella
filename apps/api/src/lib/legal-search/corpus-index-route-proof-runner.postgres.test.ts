/**
 * The route proof runner against real PostgreSQL, through the operator
 * command and the library: every route of the requested and the serving
 * generation reaches `all_current`; a decision the engine lost revokes its
 * route's proof and the same run proves the route again; a run that dies
 * mid-pass is resumed by the next one from the stored cursor, on the same
 * pass; and while a flip holds the projection mutation fence, the runner
 * records nothing and stops instead of interleaving with it.
 *
 * The suite registers a serving generation, so it runs alone on a fresh
 * clone (`EXCLUSIVE_SHARED_TABLE_DDL_TEST_PATHS`).
 */

import { panic, Result } from "better-result";
import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { createTestClock } from "@stll/test-kit";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexProjectionStates,
  corpusIndexRouteProofs,
} from "@/api/db/schema";
import { lockCorpusIndexProjectionFlipTx } from "@/api/lib/legal-search/corpus-index-projection-revision";
import {
  type CorpusIndexRouteProofRun,
  type CorpusIndexRouteProofRunOptions,
  runCorpusIndexRouteProofs,
} from "@/api/lib/legal-search/corpus-index-route-proof-runner";
import {
  type CorpusIndexGenerationRouteProofs,
  readCorpusIndexRouteProofsTx,
} from "@/api/lib/legal-search/corpus-index-route-proof-store";
import { runCorpusGenerationCommand } from "@/api/scripts/corpus-generation";
import {
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import {
  createCorpusFlipFixture,
  FLIP_V7,
  FLIP_V10,
  flipEntityId,
  flipRouteOf,
} from "@/api/tests/helpers/corpus-flip-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

/** The runner's clock: its waits advance it, so a run never waits for real. */
const clock = createTestClock();

const POL_V10 = flipRouteOf(FLIP_V10);
const DECISIONS = [1, 2, 3, 4, 5, 6];

type Fixture = ReturnType<typeof createCorpusFlipFixture>;

const runnerOf =
  (db: GatedTestDb) =>
  async <T>(work: (tx: Transaction) => Promise<T>): Promise<T> =>
    await db.transaction(async (tx) => await work(asTestRaw<Transaction>(tx)));

/** v7 serves, v10 builds, both show `DECISIONS`, every group attested, nothing proven. */
const standPair = async (db: GatedTestDb): Promise<Fixture> => {
  await db.execute(
    sql.raw(
      "TRUNCATE TABLE corpus_index_generations, corpus_index_generation_flips CASCADE",
    ),
  );
  const fixture = createCorpusFlipFixture(runnerOf(db));
  await fixture.register(FLIP_V7, "serving");
  await fixture.register(FLIP_V10, "building");
  for (const generation of [FLIP_V7, FLIP_V10] as const) {
    for (const n of DECISIONS) {
      // db-await-in-loop: fixture rows, in order
      await fixture.seedShown(generation, n);
    }
    // db-await-in-loop: fixture steps, in order
    await fixture.attestGroups(generation);
    // db-await-in-loop: fixture steps, in order
    const declared = await runnerOf(db)(
      async (tx) =>
        await readCorpusIndexRouteProofsTx(tx, {
          family: "case_law",
          generation,
        }),
    );
    if (declared.type !== "not_ready") {
      panic(`Unexpected route proofs before any pass: ${declared.type}`);
    }
    // Every declared index exists in the engine.
    for (const { indexId } of declared.routes) {
      fixture.incarnations.set(indexId, `${indexId}:01JFIRST`);
    }
  }
  return fixture;
};

const run = async (
  db: GatedTestDb,
  fixture: Fixture,
  overrides: Partial<CorpusIndexRouteProofRunOptions> = {},
): Promise<Extract<CorpusIndexRouteProofRun, { type: "ran" }>> => {
  const ran = await runCorpusIndexRouteProofs({
    runInTransaction: runnerOf(db),
    clientFor: () => fixture.engineClient,
    admit: async (_unit, work) => await work(),
    target: { family: "case_law", generation: FLIP_V10 },
    // A run that cannot finish fails the test instead of walking forever.
    budget: { endsAt: clock.now() + 20_000, pages: 500 },
    untilCurrent: true,
    concurrency: 1,
    fencePatienceMs: 0,
    pageLimit: 2,
    now: () => clock.now(),
    sleep: async (ms) => {
      await clock.advance(ms);
    },
    write: () => undefined,
    ...overrides,
  });
  return ran.type === "ran"
    ? ran
    : panic(`The run was refused: ${ran.generation} is ${String(ran.status)}`);
};

const verdictOf = (
  ran: Extract<CorpusIndexRouteProofRun, { type: "ran" }>,
  generation: string,
): CorpusIndexGenerationRouteProofs =>
  ran.proofs.get(generation) ?? panic(`${generation} was not proven`);

const proofRow = async (db: GatedTestDb, indexId: string) =>
  (
    await db
      .select({
        passNumber: corpusIndexRouteProofs.passNumber,
        passCursor: corpusIndexRouteProofs.passCursor,
        passInspected: corpusIndexRouteProofs.passInspected,
        passExpectation: corpusIndexRouteProofs.passExpectation,
        provenPassNumber: corpusIndexRouteProofs.provenPassNumber,
        provenInspected: corpusIndexRouteProofs.provenInspected,
        revokedPassNumber: corpusIndexRouteProofs.revokedPassNumber,
        revokeReason: corpusIndexRouteProofs.revokeReason,
      })
      .from(corpusIndexRouteProofs)
      .where(
        and(
          eq(corpusIndexRouteProofs.generation, FLIP_V10),
          eq(corpusIndexRouteProofs.indexId, indexId),
        ),
      )
  ).at(0) ?? panic(`No proof row for ${indexId}`);

const proofRows = async (db: GatedTestDb) =>
  await db
    .select()
    .from(corpusIndexRouteProofs)
    .orderBy(corpusIndexRouteProofs.generation, corpusIndexRouteProofs.indexId);

const withDb = async (
  work: (db: GatedTestDb, observer: GatedTestDb) => Promise<void>,
) => {
  if (databaseUrl === undefined) {
    panic("DATABASE_URL is required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const { db } = openClient();
    const { db: observer } = openClient();
    await work(db, observer);
  });
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("corpus index route proof runner (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("corpus index route proof runner (postgres)", () => {
    beforeEach(async () => {
      await withDb(async (db) => {
        await db.execute(
          sql.raw(
            "TRUNCATE TABLE corpus_index_generations, corpus_index_generation_flips CASCADE",
          ),
        );
      });
    });

    test("prove walks every route of the requested and the serving generation until all are current", async () => {
      await withDb(async (db) => {
        const fixture = await standPair(db);
        const out: string[] = [];
        const err: string[] = [];
        const code = await runCorpusGenerationCommand({
          args: [
            "prove",
            "--family",
            "case_law",
            "--generation",
            FLIP_V10,
            "--until-current",
            "--concurrency",
            "2",
          ],
          withProofDatabase: async (_budgetMs, work) =>
            await work(runnerOf(db)),
          proofBrake: { readDecision: async () => "start", maxWaitMs: 1000 },
          proofClient: () => fixture.engineClient,
          write: (line) => {
            out.push(line);
          },
          writeError: (line) => {
            err.push(line);
          },
        });
        expect({ code, err }).toEqual({ code: 0, err: [] });
        const report = out.join("\n");
        expect(report).toContain(`proving ${FLIP_V10} (requested)`);
        expect(report).toContain(`proving ${FLIP_V7} (serving)`);
        expect(report).toContain(
          "every route of every proven generation is current",
        );
        // Every declared route of both generations holds a proof.
        const rows = await proofRows(db);
        expect(new Set(rows.map(({ generation }) => generation))).toEqual(
          new Set([FLIP_V7, FLIP_V10]),
        );
        expect(rows.every(({ provenAt }) => provenAt !== null)).toBe(true);
        // The route holding the decisions proved every one of them.
        expect(await proofRow(db, POL_V10)).toMatchObject({
          provenPassNumber: 1,
          provenInspected: DECISIONS.length,
        });
      });
    });

    test("the engine losing a decision revokes the route's proof, and the run proves the route again", async () => {
      await withDb(async (db) => {
        const fixture = await standPair(db);
        const proven = await run(db, fixture);
        expect(proven.stop).toEqual({ type: "all_current" });
        expect(verdictOf(proven, FLIP_V10).type).toBe("all_current");

        fixture.loseRevision(FLIP_V10, 4);
        // Keep walking: the next pass reaches the lost decision.
        const walked = await run(db, fixture, {
          untilCurrent: false,
          budget: { endsAt: clock.now() + 20_000, pages: 400 },
        });
        const pol =
          walked.routes.find(({ route }) => route.indexId === POL_V10) ??
          panic("The route was not walked");
        expect(pol.repairs).toBe(1);
        expect(pol.proofs).toBeGreaterThanOrEqual(1);
        // Revoked by the repair, then proven by a later pass that no longer
        // counts the lost decision as applied.
        const row = await proofRow(db, POL_V10);
        expect(row.revokeReason).toBe("present_drift");
        expect(row.provenPassNumber).toBeGreaterThanOrEqual(
          row.revokedPassNumber ?? panic("The proof was never revoked"),
        );
        expect(row.provenInspected).toBe(DECISIONS.length - 1);
        expect(verdictOf(walked, FLIP_V10).type).toBe("all_current");
        const lost = await db
          .select({
            appliedRevision: corpusIndexProjectionStates.appliedRevision,
          })
          .from(corpusIndexProjectionStates)
          .where(
            and(
              eq(corpusIndexProjectionStates.generation, FLIP_V10),
              eq(corpusIndexProjectionStates.entityId, flipEntityId(4)),
            ),
          );
        expect(lost).toEqual([{ appliedRevision: null }]);
      });
    });

    test("a run that dies mid-pass is resumed by the next run on the same pass", async () => {
      await withDb(async (db) => {
        const fixture = await standPair(db);
        // The process dies while the route's third census page reads the
        // engine: two pages are recorded, the third never is.
        const died = { at: 3, censusReads: 0, dead: false };
        const dying = {
          ...fixture.engineClient,
          aggregate: async (request: { indexId: string; query: string }) => {
            if (request.indexId === POL_V10) {
              died.censusReads += 1;
              if (died.censusReads === died.at) {
                died.dead = true;
                throw new Error("process killed");
              }
            }
            return await fixture.engineClient.aggregate(request);
          },
        };
        const first = await run(db, fixture, {
          clientFor: () => dying,
          pageLimit: 1,
          untilCurrent: false,
          now: () => (died.dead ? Number.POSITIVE_INFINITY : clock.now()),
        });
        expect(died.dead).toBe(true);
        expect(first.stop).toEqual({ type: "budget_spent" });
        const midPass = await proofRow(db, POL_V10);
        expect(midPass).toMatchObject({
          passNumber: 1,
          passExpectation: "present",
          passInspected: 2,
          passCursor: flipEntityId(2),
          provenPassNumber: null,
        });

        const resumed = await run(db, fixture, { pageLimit: 1 });
        expect(resumed.stop).toEqual({ type: "all_current" });
        // The pass the dead run began is the one that proved the route: it
        // was resumed, not restarted, and counted every decision once.
        expect(await proofRow(db, POL_V10)).toMatchObject({
          provenPassNumber: 1,
          provenInspected: DECISIONS.length,
        });
      });
    });

    test("while a flip holds the projection fence the runner records nothing and stops", async () => {
      await withDb(async (db, flipDb) => {
        const fixture = await standPair(db);
        const before = await proofRows(db);
        const fenced = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        const flip = flipDb.transaction(async (tx) => {
          await lockCorpusIndexProjectionFlipTx(asTestRaw<Transaction>(tx));
          fenced.resolve(undefined);
          await release.promise;
        });
        await fenced.promise;
        const refused = await Result.tryPromise(
          async () => await run(db, fixture),
        );
        release.resolve(undefined);
        await flip;
        const stopped = refused.isOk()
          ? refused.value
          : panic("The runner failed instead of stopping");
        expect(stopped.stop).toMatchObject({ type: "lock_unavailable" });
        expect(stopped.routes.every(({ pages }) => pages === 0)).toBe(true);
        expect(await proofRows(db)).toEqual(before);

        // The flip's transaction over, the same run proves every route.
        const after = await run(db, fixture);
        expect(after.stop).toEqual({ type: "all_current" });
      });
    });
  });
}
