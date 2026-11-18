/**
 * The guarded generation flip against a real PostgreSQL schema, with route
 * proofs made by the real census pass and seeding by the real walk, and a fake
 * engine that answers the census, the document count and the index
 * incarnation from maps (`tests/helpers/corpus-flip-fixture.ts`): the flip
 * happens only with every proof, each missing or stale proof refuses with its
 * own reason, a write that lands between the walk and the fenced phase is
 * caught (ahead of the walk's cursor or behind it), the database declining
 * the flip its locks or its time refuses as busy with nothing written, the
 * receipt's digest is reproducible from the stored row, a dry run is never
 * assigned a transaction id, and the replaced generation keeps taking every
 * change, so the same guard flips back.
 *
 * Not covered here: writers running concurrently with the fenced phase (the
 * embedded database has one connection). The lock order against a canonical
 * writer, the refusal instead of a wait, and a whole flip on the operator's
 * own connection and role run against PostgreSQL in
 * `scripts/corpus-generation.postgres.test.ts`.
 */
import { panic } from "better-result";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";

import { runUnderCorpusSchemaLane } from "@/api/db/corpus-schema-lane";
import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerationFlips,
  corpusIndexGenerations,
  corpusIndexGenerationSeedingPasses,
  corpusIndexProjectionStates,
  corpusIndexRouteProofs,
  systemAuditRuns,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  type CorpusIndexFlipPlan,
  type CorpusIndexFlipRequest,
  prepareCorpusIndexGenerationFlip,
  runCorpusIndexGenerationFlip,
} from "@/api/lib/legal-search/corpus-index-generation-flip";
import {
  lockActiveCorpusProjectionSourceByIdTx,
  synchronizeLockedCaseLawProjectionBatchTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { readCorpusIndexRouteSeedingsTx } from "@/api/lib/legal-search/corpus-index-route-seeding";
import { isPgError } from "@/api/lib/pg-error";
import {
  createCorpusFlipFixture,
  FLIP_V7 as V7,
  FLIP_V10 as V10,
  flipEntityId as entityId,
  type FlipGeneration as Generation,
  flipRouteOf as routeOf,
} from "@/api/tests/helpers/corpus-flip-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const runInTransaction = async <T>(
  work: (tx: Transaction) => Promise<T>,
): Promise<T> =>
  await db.transaction(async (tx) => await work(asTestRaw<Transaction>(tx)));

const fixture = createCorpusFlipFixture(runInTransaction);
const {
  engineClient,
  incarnations,
  lost,
  proveRoutes,
  readyPair,
  register,
  attestGroups,
  seedErased,
  seedPending,
  seedRoutes,
  seedShown,
} = fixture;

const dialect = new PgDialect();

type OnExecute = (text: string, tx: Transaction) => Promise<void>;

/**
 * `tx` showing `onExecute` every statement run through `execute`, with its
 * SQL text, before it runs; savepoints it opens are shown the same way.
 */
const observeTransaction = (tx: Transaction, onExecute: OnExecute) =>
  new Proxy(tx, {
    get(target, property) {
      if (property === "execute") {
        return async (query: Parameters<Transaction["execute"]>[0]) => {
          await onExecute(
            typeof query === "string"
              ? query
              : dialect.sqlToQuery(query.getSQL()).sql,
            target,
          );
          const executed: Awaited<ReturnType<Transaction["execute"]>> =
            await target.execute(query);
          return executed;
        };
      }
      if (property === "transaction") {
        return async <T>(work: (savepoint: Transaction) => Promise<T>) =>
          await target.transaction(
            async (savepoint) =>
              await work(observeTransaction(savepoint, onExecute)),
          );
      }
      const value: unknown = Reflect.get(target, property, target);
      const bound: unknown =
        typeof value === "function" ? value.bind(target) : value;
      return bound;
    },
  });

/**
 * A transaction runner that shows `onExecute` every statement the flip runs
 * through `execute`, with its SQL text, before it runs.
 */
const observedRunner =
  (onExecute: OnExecute) =>
  async <T>(work: (tx: Transaction) => Promise<T>): Promise<T> =>
    await runInTransaction(
      async (tx) => await work(observeTransaction(tx, onExecute)),
    );

/** Raise a real PostgreSQL error with `code` on `tx`, aborting it. */
const raiseOn = async (tx: Transaction, code: string) => {
  await tx.execute(
    sql.raw(
      `DO $$ BEGIN RAISE EXCEPTION 'injected' USING ERRCODE = '${code}'; END $$`,
    ),
  );
};

const request = (
  candidate: Generation,
  replacing: Generation | null,
  overrides: Partial<CorpusIndexFlipRequest> = {},
): CorpusIndexFlipRequest => ({
  family: "case_law",
  candidate,
  replacing: { type: "named", generation: replacing },
  // A fixture's changes are all younger than any watermark: none is lag.
  exemptMinutes: 0,
  coverage: { pageSize: 2, pageBudget: 100 },
  maxProofAgeHours: 24,
  ...overrides,
});

const prepare = async (
  flip: CorpusIndexFlipRequest,
  runner: typeof runInTransaction = runInTransaction,
) =>
  await prepareCorpusIndexGenerationFlip({
    runInTransaction: runner,
    engine: engineClient,
    request: flip,
  });

const requirePlan = (
  prepared: Awaited<ReturnType<typeof prepare>>,
): Extract<CorpusIndexFlipPlan, { type: "flip" }> => {
  if (prepared.isErr()) {
    return panic(`Flip refused in phase 1: ${prepared.error.message}`);
  }
  return prepared.value.type === "flip"
    ? prepared.value
    : panic("Expected a flip plan");
};

const commit = async (
  plan: Extract<CorpusIndexFlipPlan, { type: "flip" }>,
  mode: "dry_run" | "apply" = "apply",
  runner: typeof runInTransaction = runInTransaction,
) =>
  await runCorpusIndexGenerationFlip(
    runner,
    plan,
    mode === "apply"
      ? { mode, actor: "operator:test", reason: "flip under test" }
      : { mode },
  );

const flip = async (candidate: Generation, replacing: Generation | null) =>
  await commit(requirePlan(await prepare(request(candidate, replacing))));

/** The refusal's class and reason, phase 1 or phase 2. */
const refusalOf = (
  outcome:
    Awaited<ReturnType<typeof prepare>> | Awaited<ReturnType<typeof commit>>,
) =>
  outcome.isErr()
    ? `${outcome.error.refusal.class}:${outcome.error.refusal.reason}`
    : "none";

const statuses = async () =>
  Object.fromEntries(
    (
      await db
        .select({
          generation: corpusIndexGenerations.generation,
          status: corpusIndexGenerations.status,
        })
        .from(corpusIndexGenerations)
    ).map(({ generation, status }) => [generation, status]),
  );

const receipts = async () =>
  await db
    .select({
      id: corpusIndexGenerationFlips.id,
      fromGeneration: corpusIndexGenerationFlips.fromGeneration,
      toGeneration: corpusIndexGenerationFlips.toGeneration,
      actor: corpusIndexGenerationFlips.actor,
      evidenceDigest: corpusIndexGenerationFlips.evidenceDigest,
    })
    .from(corpusIndexGenerationFlips)
    .orderBy(corpusIndexGenerationFlips.flippedAt);

/** Nothing moved: the pair as `readyPair` left it, no receipt, no audit run. */
const expectNothingWritten = async () => {
  expect(await statuses()).toEqual({ [V7]: "serving", [V10]: "building" });
  expect(await receipts()).toEqual([]);
  expect(await db.select().from(systemAuditRuns)).toEqual([]);
};

// timeout: builds the PGlite schema from every migration.
beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
}, 120_000);

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.execute(
    sql.raw(
      'TRUNCATE TABLE "corpus_index_generations", "corpus_index_projection_states", "corpus_index_projection_intents", "corpus_index_generation_flips", "corpus_index_group_enrollments", "system_audit_runs", "case_law_sources" CASCADE',
    ),
  );
  fixture.reset();
});

test("a dry run checks everything and is never assigned a transaction id; the flip swaps the pair with a receipt", async () => {
  await readyPair();
  const plan = requirePlan(await prepare(request(V10, V7)));
  expect(plan.walk?.coverage).toMatchObject({ type: "complete", walked: 3 });

  // The dry run's transaction, read at its very end: no row was written or
  // locked, so PostgreSQL never assigned it a transaction id.
  const assigned: unknown[] = [];
  const dry = await commit(
    plan,
    "dry_run",
    async (work) =>
      await runInTransaction(async (tx) => {
        const result = await work(tx);
        assigned.push(
          executedRows(
            await tx.execute(
              sql`SELECT pg_current_xact_id_if_assigned()::text AS xid`,
            ),
          ).at(0),
        );
        return result;
      }),
  );
  expect(dry.isOk() && dry.value.type).toBe("checked");
  expect(assigned).toEqual([{ xid: null }]);
  await expectNothingWritten();

  const flipped = await commit(plan);
  if (flipped.isErr() || flipped.value.type !== "flipped") {
    panic(`Expected a flip: ${refusalOf(flipped)}`);
  }
  expect(await statuses()).toEqual({ [V7]: "building", [V10]: "serving" });
  expect(flipped.value.evidence).toMatchObject({
    from: V7,
    to: V10,
    registry: {
      candidate: { generation: V10, updatedAtUs: plan.candidate.updatedAtUs },
      serving: { generation: V7, updatedAtUs: plan.serving?.updatedAtUs },
    },
    parity: {
      exemptMinutes: 0,
      walk: { pages: 2, walked: 3, last: entityId(3) },
      coverageWalked: 3,
      tail: { type: "read", walked: 0 },
      behindCursor: { type: "read", pages: 2, changedPages: 0, missing: 0 },
    },
  });
  expect(await receipts()).toEqual([
    {
      id: flipped.value.receiptId,
      fromGeneration: V7,
      toGeneration: V10,
      actor: "operator:test",
      evidenceDigest: flipped.value.evidenceDigest,
    },
  ]);
  expect(
    await db
      .select({
        subject: systemAuditRuns.subject,
        counts: systemAuditRuns.counts,
      })
      .from(systemAuditRuns)
      .where(eq(systemAuditRuns.actor, "system:corpus-generation-operator")),
  ).toEqual([
    {
      subject: flipped.value.evidence.auditRun ?? panic("no audit run named"),
      counts: { registered: 0, promoted: 1, demoted: 1 },
    },
  ]);
  // A plan is spent: the registry moved, so it cannot flip twice.
  expect(refusalOf(await commit(plan))).toBe("registry:generation_changed");
});

test("the receipt's digest is reproducible from the stored row and covers actor, reason and the flip instant", async () => {
  await readyPair();
  const flipped = await flip(V10, V7);
  if (flipped.isErr() || flipped.value.type !== "flipped") {
    panic(`Expected a flip: ${refusalOf(flipped)}`);
  }
  // Recomputed from the row alone, by an expression written out here.
  const recomputed = executedRows(
    await db.execute(sql`
      SELECT evidence_digest,
        encode(sha256(convert_to(jsonb_build_object(
          'family', family, 'from', from_generation, 'to', to_generation,
          'actor', actor, 'reason', reason,
          'flippedAtUs', (extract(epoch FROM flipped_at) * 1000000)::bigint,
          'evidence', evidence)::text, 'UTF8')), 'hex') AS recomputed,
        evidence ->> 'auditRun' AS audit_run
      FROM corpus_index_generation_flips
    `),
  );
  expect(recomputed).toEqual([
    {
      evidence_digest: flipped.value.evidenceDigest,
      recomputed: flipped.value.evidenceDigest,
      audit_run: flipped.value.evidence.auditRun,
    },
  ]);
  // Every covered column is bound to the digest: changing one breaks it.
  for (const change of [
    sql`actor = 'operator:other'`,
    sql`reason = 'another go'`,
    sql`flipped_at = flipped_at + interval '1 microsecond'`,
    sql`evidence = evidence || '{"to": "case_law_v7"}'::jsonb`,
  ]) {
    // db-await-in-loop: one rejected update per covered column
    const updated = await db
      .execute(sql`UPDATE corpus_index_generation_flips SET ${change}`)
      .then(
        () => "updated",
        (error: unknown) => error,
      );
    expect(isPgError(updated, "23514")).toBe(true);
  }
});

test("each missing or stale proof refuses with its own reason, and nothing moves", async () => {
  await readyPair();
  // Phase 1 refusals.
  expect(refusalOf(await prepare(request(V10, V10)))).toBe(
    "registry:replacing_mismatch",
  );
  await db
    .update(corpusIndexRouteProofs)
    .set({
      provenPassStartedAt: sql`clock_timestamp() - interval '2 hours'`,
    })
    .where(eq(corpusIndexRouteProofs.indexId, routeOf(V10)));
  expect(
    refusalOf(await prepare(request(V10, V7, { maxProofAgeHours: 1 }))),
  ).toBe("route_proofs:not_current");
  await db
    .delete(corpusIndexRouteProofs)
    .where(eq(corpusIndexRouteProofs.indexId, routeOf(V10)));
  expect(refusalOf(await prepare(request(V10, V7)))).toBe(
    "route_proofs:not_current",
  );
  await proveRoutes(V10);
  incarnations.set(routeOf(V10), `${routeOf(V10)}:01JSECOND`);
  expect(refusalOf(await prepare(request(V10, V7)))).toBe(
    "engine:index_replaced",
  );
  incarnations.set(routeOf(V10), `${routeOf(V10)}:01JFIRST`);
  lost.set(routeOf(V10), 1);
  expect(refusalOf(await prepare(request(V10, V7)))).toBe(
    "engine:documents_missing",
  );
  lost.clear();
  // A decision v7 shows at a newer epoch than v10 does, older than the
  // watermark: v10 would show a stale copy.
  await seedShown(V7, 2, 2);
  await seedPending(V10, 2, 2);
  const stale = requirePlan(await prepare(request(V10, V7)));
  expect(refusalOf(await commit(stale))).toBe("parity:regressions");
  await seedShown(V10, 2, 2);
  await proveRoutes(V10);
  // Phase 2 refusals: seeding of either generation.
  await db
    .delete(corpusIndexGenerationSeedingPasses)
    .where(eq(corpusIndexGenerationSeedingPasses.generation, V7));
  expect(refusalOf(await flip(V10, V7))).toBe("seeding:serving_unseeded");
  await seedRoutes(V7);
  await db
    .delete(corpusIndexGenerationSeedingPasses)
    .where(eq(corpusIndexGenerationSeedingPasses.generation, V10));
  expect(refusalOf(await flip(V10, V7))).toBe("seeding:candidate_unseeded");
  await seedRoutes(V10);
  await expectNothingWritten();
  expect((await flip(V10, V7)).isOk()).toBe(true);
});

test("the engine is read after the coverage walk: an index replaced while the walk runs is refused", async () => {
  await readyPair();
  // The walk's first page replaces v10's index, as a rebuild of it would.
  const replaced = await prepare(
    request(V10, V7),
    observedRunner(async (text) => {
      if (text.includes("AS last_entity_id")) {
        incarnations.set(routeOf(V10), `${routeOf(V10)}:01JREBUILT`);
      }
    }),
  );
  expect(refusalOf(replaced)).toBe("engine:index_replaced");
});

test("a write that lands between the walk and the fence is caught under the fence, ahead of the cursor or behind it", async () => {
  await readyPair();
  // A newer decision v7 shows, with no state in v10, after the walk ended:
  // the tail the fenced phase reads finds it.
  let plan = requirePlan(await prepare(request(V10, V7)));
  await seedShown(V7, 7);
  expect(refusalOf(await commit(plan))).toBe("parity:regressions");
  await seedShown(V10, 7);
  await proveRoutes(V10);

  // A change v7 applies to a decision the walk already passed, which v10
  // has not applied yet.
  plan = requirePlan(await prepare(request(V10, V7)));
  await seedShown(V7, 1, 3);
  await seedPending(V10, 1, 3);
  expect(refusalOf(await commit(plan))).toBe("parity:regressions");
  await seedShown(V10, 1, 3);
  await proveRoutes(V10);

  // A decision v7 shows that is created BEHIND the walk's cursor (an older
  // id, in a page the walk already read) with no state in v10: a writer that
  // projects the serving generation only. Neither the tail nor the
  // regression statement reads it; the recount of the walked pages does.
  plan = requirePlan(await prepare(request(V10, V7)));
  expect(plan.walk?.last).toBe(entityId(7));
  await seedShown(V7, 0);
  const behind = await commit(plan);
  expect(refusalOf(behind)).toBe("parity:regressions");
  expect(behind.isErr() && behind.error.details).toContain(
    `no state: ${entityId(0)}`,
  );
  await seedShown(V10, 0);
  await proveRoutes(V10);

  // A decision v7 wanted erased and v10 never had a state for (so the walk
  // found nothing missing) that v7 alone comes to show after its page was
  // read: the walk listed it, and the fenced phase probes it again.
  await seedErased(V7, 4);
  plan = requirePlan(await prepare(request(V10, V7)));
  expect(plan.walk?.uncovered).toEqual({
    type: "listed",
    entityIds: [entityId(4)],
  });
  await seedShown(V7, 4);
  expect(refusalOf(await commit(plan))).toBe("parity:regressions");
  await seedShown(V10, 4);
  await proveRoutes(V10);

  // A route proven again after the engine was read: the fence never trusts a
  // proof the engine check did not see.
  plan = requirePlan(await prepare(request(V10, V7)));
  await db
    .update(corpusIndexRouteProofs)
    .set({ provenAt: sql`clock_timestamp()` })
    .where(eq(corpusIndexRouteProofs.indexId, routeOf(V10)));
  expect(refusalOf(await commit(plan))).toBe("route_proofs:proof_changed");

  // Any lifecycle change of either generation.
  plan = requirePlan(await prepare(request(V10, V7)));
  await db
    .update(corpusIndexGenerations)
    .set({ updatedAt: sql`clock_timestamp()` })
    .where(eq(corpusIndexGenerations.generation, V7));
  expect(refusalOf(await commit(plan))).toBe("registry:generation_changed");
  expect(await statuses()).toEqual({ [V7]: "serving", [V10]: "building" });
  expect(await receipts()).toEqual([]);
});

test("the database declining the flip its locks or its time is busy, never undecided, and writes nothing", async () => {
  await readyPair();
  const plan = requirePlan(await prepare(request(V10, V7)));
  // Each failure raised for real on the fenced transaction, at the
  // statement named: a lock not granted, a statement timeout, a deadlock.
  for (const [marker, code, expected] of [
    [
      "lock_corpus_projection_mutations_exclusive",
      "55P03",
      "busy:lock_unavailable",
    ],
    ["AS last_entity_id", "57014", "busy:statement_timeout"],
    ["counted.states", "57014", "busy:statement_timeout"],
    ["pending_walk", "57014", "busy:statement_timeout"],
    ["pending_walk", "40P01", "busy:deadlock_victim"],
  ] as const) {
    // db-await-in-loop: one injected failure per run, each on a fresh transaction
    const outcome = await commit(
      plan,
      "apply",
      observedRunner(async (text, tx) => {
        if (text.includes(marker)) {
          await raiseOn(tx, code);
        }
      }),
    );
    expect(`${marker} ${code}: ${refusalOf(outcome)}`).toBe(
      `${marker} ${code}: ${expected}`,
    );
    await expectNothingWritten();
  }
  // A statement timeout in phase 1's walk is busy too.
  expect(
    refusalOf(
      await prepare(
        request(V10, V7),
        observedRunner(async (text, tx) => {
          if (text.includes("AS last_entity_id")) {
            await raiseOn(tx, "57014");
          }
        }),
      ),
    ),
  ).toBe("busy:statement_timeout");

  // The operator lane's budget runs out as the fenced work finishes, before
  // the commit: the lane aborts the transaction, so nothing is written.
  const controller = new AbortController();
  const laneSpent = await commit(
    plan,
    "apply",
    async (work) =>
      await runUnderCorpusSchemaLane({
        database: {
          transaction: async (fn) =>
            await db.transaction(
              async (tx) => await fn(asTestRaw<Transaction>(tx)),
            ),
        },
        signal: controller.signal,
        work: async (tx: Transaction) => {
          const result = await work(tx);
          controller.abort(new DOMException("budget spent", "TimeoutError"));
          controller.signal.throwIfAborted();
          return result;
        },
      }),
  );
  expect(refusalOf(laneSpent)).toBe("busy:lane_budget_spent");
  await expectNothingWritten();
  expect((await commit(plan)).isOk()).toBe(true);
});

test("the replaced generation keeps taking every change and the same guard flips back, lag exempt only within the watermark", async () => {
  await readyPair();
  expect((await flip(V10, V7)).isOk()).toBe(true);
  expect(await statuses()).toEqual({ [V7]: "building", [V10]: "serving" });

  // A decision written now gets a state in both generations, by the
  // ordinary writer.
  const sourceId = toSafeId<"caseLawSource">(
    "0198e331-e578-7000-8000-000000000a01",
  );
  const decisionId = toSafeId<"caseLawDecision">(entityId(9));
  await runInTransaction(async (tx) => {
    await tx
      .insert(caseLawSources)
      .values({ id: sourceId, adapterKey: "flip-test", name: "Flip test" });
    await tx.insert(caseLawDecisions).values({
      id: decisionId,
      sourceId,
      caseNumber: "9 As 1/2020",
      court: "Naczelny Sąd Administracyjny",
      country: "POL",
      language: "pl",
      contentHash: "9".repeat(64),
    });
    const lock = await lockActiveCorpusProjectionSourceByIdTx(tx, {
      family: "case_law",
      sourceId,
    });
    if (lock === null) {
      panic("expected an active projection lock");
    }
    await synchronizeLockedCaseLawProjectionBatchTx(tx, {
      lock,
      sourceId,
      decisionIds: [decisionId],
    });
  });
  expect(
    (
      await db
        .select({ generation: corpusIndexProjectionStates.generation })
        .from(corpusIndexProjectionStates)
        .where(eq(corpusIndexProjectionStates.entityId, decisionId))
        .orderBy(corpusIndexProjectionStates.generation)
    ).map(({ generation }) => generation),
  ).toEqual([V10, V7]);
  // Its seeding and route proofs are kept, so the flip back is guarded alike.
  expect(
    await runInTransaction(
      async (tx) =>
        await readCorpusIndexRouteSeedingsTx(tx, {
          family: "case_law",
          generation: V7,
        }),
    ),
  ).not.toBeNull();

  // After its demotion, v10 (serving) applies a change to decision 2 that
  // v7 was handed and has not applied yet: flipping back would serve the
  // older copy, so the guard refuses.
  await seedShown(V10, 2, 2);
  await seedPending(V7, 2, 2);
  expect(refusalOf(await flip(V7, V10))).toBe("parity:regressions");
  // v7 applies it: the demoted generation kept taking the change.
  await seedShown(V7, 2, 2);
  await proveRoutes(V7);

  // A change v7 was handed just now and has not applied: lag younger than
  // the watermark. Exempt with the decided 20 minutes, refused with none.
  await seedShown(V10, 3, 2);
  await seedPending(V7, 3, 2);
  const back = requirePlan(
    await prepare(request(V7, V10, { exemptMinutes: 0 })),
  );
  expect(refusalOf(await commit(back))).toBe("parity:regressions");
  const exempt = requirePlan(
    await prepare(request(V7, V10, { exemptMinutes: 20 })),
  );
  const flippedBack = await commit(exempt);
  if (flippedBack.isErr() || flippedBack.value.type !== "flipped") {
    panic(`Expected a flip back: ${refusalOf(flippedBack)}`);
  }
  expect(flippedBack.value.evidence.parity).toMatchObject({
    exemptMinutes: 20,
    exempt: 1,
  });
  expect(await statuses()).toEqual({ [V7]: "serving", [V10]: "building" });
  expect(
    (await receipts()).map(({ fromGeneration, toGeneration }) => [
      fromGeneration,
      toGeneration,
    ]),
  ).toEqual([
    [V7, V10],
    [V10, V7],
  ]);
  // v7 serves decision 2 at the epoch it applied after its demotion.
  expect(
    await db
      .select({ appliedEpoch: corpusIndexProjectionStates.appliedEpoch })
      .from(corpusIndexProjectionStates)
      .where(
        and(
          eq(corpusIndexProjectionStates.generation, V7),
          eq(corpusIndexProjectionStates.entityId, entityId(2)),
        ),
      ),
  ).toEqual([{ appliedEpoch: 2n }]);
});

test("a family's first flip needs the candidate's proofs and seeding only", async () => {
  await register(V10, "building");
  await seedShown(V10, 1);
  await attestGroups(V10);
  await proveRoutes(V10);
  await seedRoutes(V10);
  const plan = requirePlan(await prepare(request(V10, null)));
  expect(plan.walk).toBeNull();
  const flipped = await commit(plan);
  expect(flipped.isOk() && flipped.value.type).toBe("flipped");
  expect(await statuses()).toEqual({ [V10]: "serving" });
  expect((await receipts()).at(0)).toMatchObject({
    fromGeneration: null,
    toGeneration: V10,
  });
  expect((await prepare(request(V10, null))).isOk()).toBe(true);
});
