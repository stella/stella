/**
 * The guarded generation flip against a real PostgreSQL schema, with route
 * proofs made by the real census pass and seeding by the real walk, and a fake
 * engine that answers the census, the document count and the index
 * incarnation from maps: the flip happens only with every proof, each missing
 * or stale proof refuses with its own reason, a write that lands between the
 * engine phase and the fenced phase is caught, the replaced generation keeps
 * taking every change, and the same guard flips back.
 *
 * Not covered here: writers running concurrently with the fenced phase (the
 * embedded database has one connection). The lock order against a canonical
 * writer, and the refusal instead of a wait, run against PostgreSQL in
 * `scripts/corpus-generation.postgres.test.ts`.
 */
import { panic, Result } from "better-result";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerationFlips,
  corpusIndexGenerations,
  corpusIndexGenerationSeedingPasses,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  corpusIndexRouteProofs,
  systemAuditRuns,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  type CorpusIndexFlipPlan,
  type CorpusIndexFlipRequest,
  prepareCorpusIndexGenerationFlip,
  runCorpusIndexGenerationFlip,
} from "@/api/lib/legal-search/corpus-index-generation-flip";
import { registeredCorpusIndexGroups } from "@/api/lib/legal-search/corpus-index-group-contract";
import {
  attestCorpusIndexGroupEnrollmentTx,
  bindCorpusIndexGroupEnrollmentTx,
} from "@/api/lib/legal-search/corpus-index-group-enrollment-store";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  lockActiveCorpusProjectionSourceByIdTx,
  synchronizeLockedCaseLawProjectionBatchTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { advanceCorpusIndexRouteProof } from "@/api/lib/legal-search/corpus-index-route-proof";
import { readCorpusIndexRouteProofsTx } from "@/api/lib/legal-search/corpus-index-route-proof-store";
import {
  advanceCorpusIndexGenerationSeedingTx,
  readCorpusIndexRouteSeedingsTx,
} from "@/api/lib/legal-search/corpus-index-route-seeding";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const V7 = "case_law_v7";
const V10 = "case_law_v10";
type Generation = typeof V7 | typeof V10;

const APPLIED_AT = new Date("2026-08-26T00:00:00.000Z");
const fingerprint = (epoch: number) => String(epoch).padStart(64, "0");
/** Time-ordered ids, as decision ids are: a larger n is a newer decision. */
const entityId = (n: number) =>
  `0198e331-e578-7000-8000-${String(n).padStart(12, "0")}`;
const revisionId = (generation: Generation, n: number, epoch: number) =>
  toSafeId<"corpusIndexProjectionIntent">(
    `0198e331-e578-7000-9${generation === V7 ? "007" : "010"}-${String(n * 10 + epoch).padStart(12, "0")}`,
  );
const routeOf = (generation: Generation) => `${generation}_pol`;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

/** What the fake engine holds: projection revision to index and count. */
let engine: Map<string, { indexId: string; count: number }>;
/** Documents lost from an index, by index id. */
let lost: Map<string, number>;
/** The incarnation of each index id; absent means the index is missing. */
let incarnations: Map<string, string>;

const PROJECTION_REVISION_TERM = /projection_revision:"(?<revision>[^"]+)"/gu;

const engineClient = {
  aggregate: async ({ query }: { indexId: string; query: string }) =>
    Result.ok({
      projection_revisions: {
        buckets: [...query.matchAll(PROJECTION_REVISION_TERM)].flatMap(
          ({ groups }) => {
            const revision = groups?.["revision"];
            const count =
              revision === undefined ? undefined : engine.get(revision)?.count;
            return count === undefined || count === 0
              ? []
              : [{ key: revision, doc_count: count }];
          },
        ),
        doc_count_error_upper_bound: 0,
        sum_other_doc_count: 0,
      },
    }),
  search: async ({ indexId }: { indexId: string }) =>
    Result.ok({
      numHits:
        [...engine.values()]
          .filter((held) => held.indexId === indexId)
          .reduce((total, held) => total + held.count, 0) -
        (lost.get(indexId) ?? 0),
      hits: [],
      snippets: [],
    }),
  readIndexIncarnation: async (indexId: string) => {
    const incarnation = incarnations.get(indexId);
    return Result.ok(
      incarnation === undefined
        ? ({ type: "missing" } as const)
        : ({ type: "present", incarnation } as const),
    );
  },
};

const runInTransaction = async <T>(
  work: (tx: Transaction) => Promise<T>,
): Promise<T> =>
  await db.transaction(async (tx) => await work(asTestRaw<Transaction>(tx)));

const register = async (
  generation: Generation,
  status: "building" | "serving",
) =>
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS[generation],
    ),
    status,
  });

/** Attest every group the generation enrolls on its own. */
const attestGroups = async (generation: Generation) => {
  const manifest = CORPUS_INDEX_MANIFESTS[generation];
  for (const group of registeredCorpusIndexGroups(manifest)) {
    // db-await-in-loop: one attestation per registered group
    await runInTransaction(async (tx) => {
      await bindCorpusIndexGroupEnrollmentTx(tx, {
        manifest,
        indexGroup: group.indexGroup,
      });
      await attestCorpusIndexGroupEnrollmentTx(tx, {
        manifest,
        indexGroup: group.indexGroup,
        effectiveDigest: group.effectiveDigest,
      });
    });
  }
};

/** Prove every route the generation declares through the real census pass. */
const proveRoutes = async (generation: Generation) => {
  const read = await runInTransaction(
    async (tx) =>
      await readCorpusIndexRouteProofsTx(tx, {
        family: "case_law",
        generation,
      }),
  );
  if (read.type !== "not_ready" && read.type !== "all_current") {
    return panic(`Unexpected route proofs: ${read.type}`);
  }
  for (const { indexId } of read.routes) {
    if (!incarnations.has(indexId)) {
      incarnations.set(indexId, `${indexId}:01JFIRST`);
    }
    for (let page = 0; ; page += 1) {
      // db-await-in-loop: each page's cursor is the one the page before recorded
      const step = await advanceCorpusIndexRouteProof({
        runInTransaction,
        client: engineClient,
        admit: async (_unit, work) => await work(),
        route: { family: "case_law", generation, indexId },
        limit: 8,
      });
      if (step.isErr() || page > 50) {
        return panic(`Route census failed on ${indexId}`);
      }
      if (step.value.type === "proven") {
        break;
      }
    }
  }
};

/** Walk the generation's seeding pass to its end. */
const seedRoutes = async (generation: Generation) => {
  for (let page = 0; page < 20; page += 1) {
    // db-await-in-loop: each page resumes from the cursor the page before stored
    const step = await runInTransaction(
      async (tx) =>
        await advanceCorpusIndexGenerationSeedingTx(
          tx,
          { family: "case_law", generation },
          { limit: 100 },
        ),
    );
    if (step.type === "completed" || step.type === "complete") {
      return;
    }
  }
  return panic(`Seeding did not end: ${generation}`);
};

/** A decision the generation shows at `epoch`, held by the engine. */
const seedShown = async (generation: Generation, n: number, epoch = 1) => {
  const revision = revisionId(generation, n, epoch);
  const indexId = routeOf(generation);
  await db.insert(corpusIndexProjectionIntents).values({
    id: revision,
    family: "case_law",
    generation,
    entityId: entityId(n),
    epoch: BigInt(epoch),
    fingerprint: fingerprint(epoch),
    indexId,
    status: "applied",
    appendStartedAt: APPLIED_AT,
    appendCommittedAt: APPLIED_AT,
    expectedDocumentCount: 3,
    appliedAt: APPLIED_AT,
  });
  await db
    .insert(corpusIndexProjectionStates)
    .values({
      family: "case_law",
      generation,
      entityId: entityId(n),
      desiredAction: "upsert",
      desiredEpoch: BigInt(epoch),
      desiredFingerprint: fingerprint(epoch),
      desiredIndexId: indexId,
      appliedAction: "upsert",
      appliedEpoch: BigInt(epoch),
      appliedRevision: revision,
      appliedFingerprint: fingerprint(epoch),
      appliedIndexId: indexId,
      appliedAt: APPLIED_AT,
    })
    .onConflictDoUpdate({
      target: [
        corpusIndexProjectionStates.family,
        corpusIndexProjectionStates.generation,
        corpusIndexProjectionStates.entityId,
      ],
      set: {
        desiredEpoch: BigInt(epoch),
        desiredFingerprint: fingerprint(epoch),
        appliedEpoch: BigInt(epoch),
        appliedRevision: revision,
        appliedFingerprint: fingerprint(epoch),
      },
    });
  engine.set(revision, { indexId, count: 3 });
};

/** The candidate was handed a change it has not applied yet. */
const seedPending = async (generation: Generation, n: number, epoch: number) =>
  await db
    .update(corpusIndexProjectionStates)
    .set({
      desiredEpoch: BigInt(epoch),
      desiredFingerprint: fingerprint(epoch),
    })
    .where(
      and(
        eq(corpusIndexProjectionStates.generation, generation),
        eq(corpusIndexProjectionStates.entityId, entityId(n)),
      ),
    );

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

const prepare = async (flip: CorpusIndexFlipRequest) =>
  await prepareCorpusIndexGenerationFlip({
    runInTransaction,
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
) =>
  await runCorpusIndexGenerationFlip(
    runInTransaction,
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
      fromGeneration: corpusIndexGenerationFlips.fromGeneration,
      toGeneration: corpusIndexGenerationFlips.toGeneration,
      actor: corpusIndexGenerationFlips.actor,
      evidenceDigest: corpusIndexGenerationFlips.evidenceDigest,
    })
    .from(corpusIndexGenerationFlips)
    .orderBy(corpusIndexGenerationFlips.flippedAt);

/** v7 serves, v10 builds; both show decisions 1-3, every route proven and seeded. */
const readyPair = async () => {
  await register(V7, "serving");
  await register(V10, "building");
  for (const generation of [V7, V10] as const) {
    for (const n of [1, 2, 3]) {
      // db-await-in-loop: fixture rows, in order
      await seedShown(generation, n);
    }
    // db-await-in-loop: fixture steps, in order
    await attestGroups(generation);
    // db-await-in-loop: fixture steps, in order
    await proveRoutes(generation);
    // db-await-in-loop: fixture steps, in order
    await seedRoutes(generation);
  }
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
  engine = new Map();
  lost = new Map();
  incarnations = new Map();
});

test("a dry run checks everything and writes nothing; the flip swaps the pair with a receipt; the same guard flips back", async () => {
  await readyPair();
  const plan = requirePlan(await prepare(request(V10, V7)));
  expect(plan.walk?.coverage).toMatchObject({ type: "complete", walked: 3 });

  const dry = await commit(plan, "dry_run");
  expect(dry.isOk() && dry.value.type).toBe("checked");
  expect(await statuses()).toEqual({ [V7]: "serving", [V10]: "building" });
  expect(await receipts()).toEqual([]);

  const flipped = await commit(plan);
  if (flipped.isErr() || flipped.value.type !== "flipped") {
    return panic(`Expected a flip: ${refusalOf(flipped)}`);
  }
  expect(await statuses()).toEqual({ [V7]: "building", [V10]: "serving" });
  expect(flipped.value.evidence).toMatchObject({
    from: V7,
    to: V10,
    parity: { coverageWalked: 3, tail: { type: "read", walked: 0 } },
  });
  expect(await receipts()).toEqual([
    {
      fromGeneration: V7,
      toGeneration: V10,
      actor: "operator:test",
      evidenceDigest: flipped.value.evidenceDigest,
    },
  ]);
  expect(
    await db
      .select({ counts: systemAuditRuns.counts })
      .from(systemAuditRuns)
      .where(eq(systemAuditRuns.actor, "system:corpus-generation-operator")),
  ).toEqual([{ counts: { registered: 0, promoted: 1, demoted: 1 } }]);
  // A plan is spent: the registry moved, so it cannot flip twice.
  expect(refusalOf(await commit(plan))).toBe("registry:generation_changed");

  // The replaced generation keeps every change: a decision written now gets
  // a state in both generations, by the ordinary writer.
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
      return panic("expected an active projection lock");
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
  // The new decision is shown by neither generation yet, so neither direction
  // regresses on it; the same guard flips back with nothing lost.
  const back = await flip(V7, V10);
  expect(back.isOk() && back.value.type).toBe("flipped");
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
  const shown = await db
    .select({ generation: corpusIndexProjectionStates.generation })
    .from(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.appliedAction, "upsert"));
  expect(shown.filter(({ generation }) => generation === V7)).toHaveLength(3);
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
  expect(await statuses()).toEqual({ [V7]: "serving", [V10]: "building" });
  expect(await receipts()).toEqual([]);
  expect((await flip(V10, V7)).isOk()).toBe(true);
});

test("a write that lands between the engine phase and the fence is caught under the fence", async () => {
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
