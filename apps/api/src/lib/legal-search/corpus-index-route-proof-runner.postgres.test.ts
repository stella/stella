/**
 * The route proof runner against real PostgreSQL, through the operator
 * command and the library: every route of the requested and the serving
 * generation reaches `all_current`; with `--only-requested` the serving
 * generation is never walked; an until-current run gives a current route no
 * page while another is not current, and walks again a proof revoked or
 * expired before or during the run; a decision the engine lost revokes its
 * route's proof and the same run proves the route again; a run that dies
 * mid-pass is resumed by the next one from the stored cursor, on the same
 * pass; while a flip holds the projection mutation fence, the runner
 * records nothing and stops instead of interleaving with it; and two runners
 * picking up a pass too old to prove restart it once, under any interleaving,
 * while a revocation interleaved with that restart wins.
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
  corpusIndexGroupEnrollments,
  corpusIndexProjectionStates,
  corpusIndexRouteProofs,
} from "@/api/db/schema";
import { lockCorpusIndexProjectionFlipTx } from "@/api/lib/legal-search/corpus-index-projection-revision";
import {
  CORPUS_INDEX_ROUTE_PROOF_REFRESH_MS,
  type CorpusIndexRouteProofRun,
  type CorpusIndexRouteProofRunOptions,
  runCorpusIndexRouteProofs,
} from "@/api/lib/legal-search/corpus-index-route-proof-runner";
import {
  type CorpusIndexGenerationRouteProofs,
  type CorpusIndexRoute,
  type CorpusIndexRouteCensusStart,
  readCorpusIndexRouteProofsTx,
  recordCorpusIndexRouteCensusPageTx,
  revokeCorpusIndexRouteProofTx,
  startCorpusIndexRouteCensusPageTx,
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
import { withInterleaving } from "@/api/tests/helpers/transaction-interleaving";

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
    pace: async () => await Promise.resolve({ type: "start" } as const),
    target: { family: "case_law", generation: FLIP_V10 },
    // A run that cannot finish fails the test instead of walking forever.
    budget: { endsAt: clock.now() + 20_000, pages: 500 },
    onlyRequested: false,
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

/** Run the operator command against the test database and fake engine. */
const runCommand = async (
  db: GatedTestDb,
  fixture: Fixture,
  args: string[],
): Promise<{ code: number; out: string; err: string[] }> => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCorpusGenerationCommand({
    args,
    withProofDatabase: async (_budgetMs, work) => await work(runnerOf(db)),
    proofBrake: { readDecision: async () => "start", maxWaitMs: 1000 },
    proofClient: () => fixture.engineClient,
    write: (line) => {
      out.push(line);
    },
    writeError: (line) => {
      err.push(line);
    },
  });
  return { code, out: out.join("\n"), err };
};

/** Pages each route was given, by index id. */
const pagesOf = (ran: Extract<CorpusIndexRouteProofRun, { type: "ran" }>) =>
  Object.fromEntries(
    ran.routes.map(({ route, pages }) => [route.indexId, pages]),
  );

/**
 * Move the route's proof back past the maximum age, and its group's
 * attestation further back, so the proof reads `expired` (not younger than
 * the attestation it rests on).
 */
const expireProof = async (db: GatedTestDb, indexId: string) => {
  await db
    .update(corpusIndexGroupEnrollments)
    .set({ attestedAt: sql`clock_timestamp() - INTERVAL '27 hours'` })
    .where(
      and(
        eq(corpusIndexGroupEnrollments.generation, FLIP_V10),
        eq(corpusIndexGroupEnrollments.physicalIndexId, indexId),
      ),
    );
  await db
    .update(corpusIndexRouteProofs)
    .set({
      provenPassStartedAt: sql`clock_timestamp() - INTERVAL '26 hours'`,
      provenAt: sql`clock_timestamp() - INTERVAL '25 hours'`,
    })
    .where(
      and(
        eq(corpusIndexRouteProofs.generation, FLIP_V10),
        eq(corpusIndexRouteProofs.indexId, indexId),
      ),
    );
};

/** The route holding the decisions, as the store addresses it. */
const POL_ROUTE = {
  family: "case_law",
  generation: FLIP_V10,
  indexId: POL_V10,
} as const satisfies CorpusIndexRoute;
const POL_INCARNATION = `${POL_V10}:01JFIRST`;
const STALE_PASS_ID = "00000000-0000-4000-b000-000000000001";

type StartedPass = Extract<CorpusIndexRouteCensusStart, { type: "pass" }>;

/** One runner picking up the route's pass, as a census page starts. */
const startPolPage = async (tx: Transaction): Promise<StartedPass> => {
  const started = await startCorpusIndexRouteCensusPageTx(tx, POL_ROUTE, {
    type: "present",
    incarnation: POL_INCARNATION,
  });
  return started.type === "pass"
    ? started
    : panic(`The route was not walked: ${started.type}`);
};

/** The route's open pass is two decisions in and started 25 hours ago. */
const standPassTooOldToProve = async (db: GatedTestDb) => {
  await db
    .update(corpusIndexRouteProofs)
    .set({
      passNumber: 1,
      passId: STALE_PASS_ID,
      passStartedAt: sql`clock_timestamp() - INTERVAL '25 hours'`,
      passExpectation: "present",
      passCursor: flipEntityId(2),
      passInspected: 2,
      passIndexIncarnation: POL_INCARNATION,
      revokedAt: null,
      revokeReason: null,
      revokedPassNumber: null,
    })
    .where(
      and(
        eq(corpusIndexRouteProofs.generation, FLIP_V10),
        eq(corpusIndexRouteProofs.indexId, POL_V10),
      ),
    );
};

/** The route's pass as the database holds it after both transactions. */
const polPassState = async (db: GatedTestDb) =>
  (
    await db
      .select({
        passNumber: corpusIndexRouteProofs.passNumber,
        passId: corpusIndexRouteProofs.passId,
        passCursor: corpusIndexRouteProofs.passCursor,
        passInspected: corpusIndexRouteProofs.passInspected,
        revokeReason: corpusIndexRouteProofs.revokeReason,
        revokedPassNumber: corpusIndexRouteProofs.revokedPassNumber,
        young: sql<boolean>`${corpusIndexRouteProofs.passStartedAt}
          >= clock_timestamp() - INTERVAL '1 hour'`,
      })
      .from(corpusIndexRouteProofs)
      .where(
        and(
          eq(corpusIndexRouteProofs.generation, FLIP_V10),
          eq(corpusIndexRouteProofs.indexId, POL_V10),
        ),
      )
  ).at(0) ?? panic(`No proof row for ${POL_V10}`);

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

    test("prove --only-requested walks the requested generation alone and exits 0 once its routes are current", async () => {
      await withDb(async (db) => {
        const fixture = await standPair(db);
        const args = [
          "prove",
          "--family",
          "case_law",
          "--generation",
          FLIP_V10,
          "--until-current",
          "--only-requested",
          "--concurrency",
          "2",
        ];
        // The fixture's attestations already wrote the serving generation's
        // rows (each revokes); the run must leave them exactly as they are.
        const servingBefore = (await proofRows(db)).filter(
          ({ generation }) => generation === FLIP_V7,
        );
        expect(servingBefore.length).toBeGreaterThan(0);
        const first = await runCommand(db, fixture, args);
        expect({ code: first.code, err: first.err }).toEqual({
          code: 0,
          err: [],
        });
        expect(first.out).toContain(`proving ${FLIP_V10} (requested)`);
        expect(first.out).not.toContain(`proving ${FLIP_V7}`);
        // The serving generation was never walked: its rows are untouched and
        // unproven, and the run still ends 0, since every selected route is
        // current.
        const rows = await proofRows(db);
        expect(rows.filter(({ generation }) => generation === FLIP_V7)).toEqual(
          servingBefore,
        );
        expect(servingBefore.every(({ provenAt }) => provenAt === null)).toBe(
          true,
        );
        const requested = rows.filter(
          ({ generation }) => generation === FLIP_V10,
        );
        expect(requested.length).toBeGreaterThan(0);
        expect(requested.every(({ provenAt }) => provenAt !== null)).toBe(true);

        // Every selected route current already: the run walks nothing.
        const again = await runCommand(db, fixture, args);
        expect({ code: again.code, err: again.err }).toEqual({
          code: 0,
          err: [],
        });
        expect(again.out).toContain(
          "every route of every proven generation is current",
        );
        expect(again.out).not.toMatch(/: [1-9]\d* pages,/u);
        expect(await proofRows(db)).toEqual(rows);

        // The option belongs to prove alone.
        const misplaced = await runCommand(db, fixture, [
          "seed",
          "--family",
          "case_law",
          "--generation",
          FLIP_V10,
          "--only-requested",
        ]);
        expect(misplaced.code).toBe(1);
        expect(misplaced.err.join("\n")).toContain(
          "--only-requested and --concurrency belong to prove",
        );
      });
    });

    test("an until-current run gives a current route no page while a revoked one is walked again", async () => {
      await withDb(async (db) => {
        const fixture = await standPair(db);
        const proven = await run(db, fixture, { onlyRequested: true });
        expect(proven.stop).toEqual({ type: "all_current" });
        expect(proven.generations.map(({ generation }) => generation)).toEqual([
          FLIP_V10,
        ]);
        await runnerOf(db)(
          async (tx) =>
            await revokeCorpusIndexRouteProofTx(tx, POL_ROUTE, "present_drift"),
        );
        const othersBefore = (await proofRows(db)).filter(
          ({ indexId }) => indexId !== POL_V10,
        );
        expect(othersBefore.length).toBeGreaterThan(0);

        // One worker, so round robin alone would hand the current routes
        // every other page.
        const again = await run(db, fixture, { onlyRequested: true });
        expect(again.stop).toEqual({ type: "all_current" });
        expect(verdictOf(again, FLIP_V10).type).toBe("all_current");
        // The revoked route alone was walked, and proven again by a pass the
        // revocation started.
        const pages = pagesOf(again);
        expect(pages[POL_V10]).toBeGreaterThan(0);
        expect(
          Object.entries(pages).filter(
            ([indexId, walked]) => indexId !== POL_V10 && walked > 0,
          ),
        ).toEqual([]);
        const row = await proofRow(db, POL_V10);
        expect(row.provenPassNumber).toBeGreaterThanOrEqual(
          row.revokedPassNumber ?? panic("The proof was never revoked"),
        );
        expect(row.provenInspected).toBe(DECISIONS.length);
        // The current routes' rows are untouched: no page, no new pass.
        expect(
          (await proofRows(db)).filter(({ indexId }) => indexId !== POL_V10),
        ).toEqual(othersBefore);
      });
    });

    test("an until-current run walks again a proof expired before it and one revoked while it walks", async () => {
      await withDb(async (db, observer) => {
        const fixture = await standPair(db);
        const proven = await run(db, fixture, { onlyRequested: true });
        expect(proven.stop).toEqual({ type: "all_current" });
        const revokedLater =
          proven.routes.find(({ route }) => route.indexId !== POL_V10)?.route ??
          panic("The generation declares one route only");
        await expireProof(db, POL_V10);
        const expired = await runnerOf(db)(
          async (tx) =>
            await readCorpusIndexRouteProofsTx(tx, {
              family: "case_law",
              generation: FLIP_V10,
            }),
        );
        expect(
          expired.type === "not_ready"
            ? expired.routes.map(({ indexId, status }) => [
                indexId,
                status.type,
              ])
            : expired.type,
        ).toEqual(
          proven.routes.map(({ route }) => [
            route.indexId,
            route.indexId === POL_V10 ? "expired" : "current",
          ]),
        );

        // While the run walks the expired route, another's proof is revoked
        // and the run's reading of which routes are current grows stale.
        const revocation = { done: false };
        const revoking: Fixture["engineClient"] = {
          ...fixture.engineClient,
          readIndexIncarnation: async (...args) => {
            if (args[0] === POL_V10 && !revocation.done) {
              revocation.done = true;
              await observer.transaction(
                async (tx) =>
                  await revokeCorpusIndexRouteProofTx(
                    asTestRaw<Transaction>(tx),
                    revokedLater,
                    "present_drift",
                  ),
              );
              await clock.advance(CORPUS_INDEX_ROUTE_PROOF_REFRESH_MS);
            }
            return await fixture.engineClient.readIndexIncarnation(...args);
          },
        };
        const again = await run(db, fixture, {
          onlyRequested: true,
          clientFor: () => revoking,
          budget: {
            endsAt: clock.now() + 10 * CORPUS_INDEX_ROUTE_PROOF_REFRESH_MS,
            pages: 500,
          },
        });
        expect(revocation.done).toBe(true);
        expect(again.stop).toEqual({ type: "all_current" });
        const walked = again.routes.flatMap(({ route, pages, proofs }) =>
          pages > 0 ? [[route.indexId, proofs]] : [],
        );
        expect(Object.fromEntries(walked)).toEqual({
          [POL_V10]: 1,
          [revokedLater.indexId]: 1,
        });
        expect(verdictOf(again, FLIP_V10).type).toBe("all_current");
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
        // Without --until-current every route of both generations keeps
        // being walked, current or not.
        expect(
          new Set(walked.generations.map(({ generation }) => generation)),
        ).toEqual(new Set([FLIP_V7, FLIP_V10]));
        expect(walked.routes.every(({ pages }) => pages > 0)).toBe(true);
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

    test("two runners picking up a pass too old to prove restart it once, in any order", async () => {
      await withDb(async (db) => {
        await standPair(db);
        await runnerOf(db)(startPolPage);
        const started: StartedPass[] = [];
        const runner = {
          steps: [
            {
              name: "start",
              run: async (tx: Transaction) => {
                started.push(await startPolPage(tx));
              },
            },
          ],
        };
        await withInterleaving({
          databaseUrl,
          a: runner,
          b: runner,
          reset: async () => {
            started.length = 0;
            await standPassTooOldToProve(db);
          },
          readState: async () => await polPassState(db),
          invariant: ({ outcomes, state }) => {
            expect(outcomes).toEqual({
              a: { status: "committed" },
              b: { status: "committed" },
            });
            // One restart between them, from the beginning, not a revocation.
            expect(state).toMatchObject({
              passNumber: 2,
              passCursor: null,
              passInspected: 0,
              revokeReason: null,
              young: true,
            });
            expect(state.passId).not.toBe(STALE_PASS_ID);
            expect(started).toHaveLength(2);
            expect(
              started.flatMap(({ restarted }) =>
                restarted === null ? [] : [restarted.reason],
              ),
            ).toEqual(["pass_too_old_to_prove"]);
            // Both runners walk the one new pass.
            expect(started.map(({ pass }) => pass.id)).toEqual([
              state.passId,
              state.passId,
            ]);
          },
        });
      });
    });

    test("a revocation interleaved with the restart of a pass too old to prove wins", async () => {
      await withDb(async (db) => {
        await standPair(db);
        await runnerOf(db)(startPolPage);
        const started: StartedPass[] = [];
        await withInterleaving({
          databaseUrl,
          a: {
            steps: [
              {
                name: "start",
                run: async (tx) => {
                  started.push(await startPolPage(tx));
                },
              },
            ],
          },
          b: {
            steps: [
              {
                name: "revoke",
                run: async (tx) => {
                  await revokeCorpusIndexRouteProofTx(
                    tx,
                    POL_ROUTE,
                    "group_withdrawn",
                  );
                },
              },
            ],
          },
          reset: async () => {
            started.length = 0;
            await standPassTooOldToProve(db);
          },
          readState: async () => await polPassState(db),
          invariant: async ({ outcomes, state }) => {
            expect(outcomes).toEqual({
              a: { status: "committed" },
              b: { status: "committed" },
            });
            const runner = started.at(0) ?? panic("The runner started no page");
            // The revocation's pass is the route's pass, whichever committed
            // first: a restart before it is revoked over, and a restart after
            // it finds the pass moved and leaves it.
            expect(state).toMatchObject({
              passNumber: runner.restarted === null ? 2 : 3,
              revokeReason: "group_withdrawn",
              revokedPassNumber: state.passNumber,
              passCursor: null,
              passInspected: 0,
              young: true,
            });
            if (runner.restarted !== null) {
              // The page read on the restarted pass is not recorded.
              expect(
                await runnerOf(db)(
                  async (tx) =>
                    await recordCorpusIndexRouteCensusPageTx(tx, {
                      route: POL_ROUTE,
                      pass: runner.pass,
                      incarnation: POL_INCARNATION,
                      inspected: 2,
                      nextCursor: flipEntityId(2),
                      complete: false,
                    }),
                ),
              ).toEqual({ type: "superseded" });
            } else {
              expect(runner.pass.id).toBe(state.passId);
            }
          },
        });
      });
    });
  });
}
