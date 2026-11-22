/**
 * A flip's fallback policy against a real PostgreSQL schema, with the flip
 * fixture's v7 / v10 pair (route proofs by the real census pass, seeding by
 * the real walk) holding decisions of three jurisdictions, two of which share
 * one index in v7 (`cs_sk`) and have indexes of their own in v10: a forward
 * flip records the policy and its own parity is unchanged; a fallback over
 * that exact pair keeps the named jurisdiction on v10, through the serving
 * mutation, for the flip and for a direct caller alike, while every other
 * jurisdiction, the one sharing its old index included, keeps full parity;
 * a wrong pair or code is refused; dry run, receipt and a second prepare
 * agree; reads follow the kept route; and the generation a kept jurisdiction
 * stays on cannot be retired or rebuilt while it serves it.
 */
import { panic } from "better-result";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerationFlips,
  corpusIndexGenerations,
  corpusIndexJurisdictionServing,
} from "@/api/db/schema";
import type { CorpusIndexFallbackPolicy } from "@/api/lib/legal-search/corpus-index-fallback-policy";
import {
  type CorpusIndexFlipPlan,
  type CorpusIndexFlipRequest,
  prepareCorpusIndexGenerationFlip,
  runCorpusIndexGenerationFlip,
} from "@/api/lib/legal-search/corpus-index-generation-flip";
import { corpusIndexGenerationFlipReceiptDigest } from "@/api/lib/legal-search/corpus-index-generation-flip-receipt";
import { readCorpusIndexRetireTx } from "@/api/lib/legal-search/corpus-index-generation-retire";
import {
  beginCorpusIndexGenerationRebuildTx,
  setServingCorpusIndexGenerationTx,
} from "@/api/lib/legal-search/corpus-index-generation-store";
import { readServingCorpusIndexTargetTx } from "@/api/lib/legal-search/corpus-index-group-enrollment-store";
import {
  createCorpusFlipFixture,
  FLIP_V7 as V7,
  FLIP_V10 as V10,
  flipEntityId as entityId,
  type FlipGeneration as Generation,
  flipRouteIn as routeIn,
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
  proveRoutes,
  register,
  attestGroups,
  seedPending,
  seedRoutes,
  seedShown,
} = fixture;

/** Decision 1 is Polish, 2 Czech, 3 Slovak: 2 and 3 share `cs_sk` in v7. */
const POL = 1;
const CZE = 2;
const SVK = 3;
const JURISDICTION_OF = { [POL]: "POL", [CZE]: "CZE", [SVK]: "SVK" } as const;

/** The policy the forward flip v7 -> v10 records: CZE stays on v10. */
const KEEP_CZE: CorpusIndexFallbackPolicy = {
  fromGeneration: V7,
  toGeneration: V10,
  keepOnNewer: ["CZE"],
};

const request = (
  candidate: Generation,
  replacing: Generation | null,
  rollbackPolicy: CorpusIndexFallbackPolicy | null = null,
): CorpusIndexFlipRequest => ({
  family: "case_law",
  candidate,
  replacing: { type: "named", generation: replacing },
  // A fixture's changes are all younger than any watermark: none is lag.
  exemptMinutes: 0,
  coverage: { pageSize: 2, pageBudget: 100 },
  maxProofAgeHours: 24,
  rollbackPolicy,
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

/** The refusal's class and reason, phase 1 or phase 2. */
const refusalOf = (
  outcome:
    Awaited<ReturnType<typeof prepare>> | Awaited<ReturnType<typeof commit>>,
) =>
  outcome.isErr()
    ? `${outcome.error.refusal.class}:${outcome.error.refusal.reason}`
    : "none";

/** Prepare and apply; the outcome, refused or flipped. */
const flip = async (
  candidate: Generation,
  replacing: Generation,
  policy: CorpusIndexFallbackPolicy | null = null,
) => {
  const prepared = await prepare(request(candidate, replacing, policy));
  return prepared.isErr() ? prepared : await commit(requirePlan(prepared));
};

const requireFlipped = (outcome: Awaited<ReturnType<typeof commit>>) =>
  outcome.isOk() && outcome.value.type === "flipped"
    ? outcome.value
    : panic(`Expected a flip: ${refusalOf(outcome)}`);

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

const pointers = async () =>
  await db
    .select({
      jurisdiction: corpusIndexJurisdictionServing.jurisdiction,
      generation: corpusIndexJurisdictionServing.generation,
      fromGeneration: corpusIndexJurisdictionServing.fromGeneration,
    })
    .from(corpusIndexJurisdictionServing)
    .orderBy(corpusIndexJurisdictionServing.jurisdiction);

const KEPT_POINTER = {
  jurisdiction: "CZE",
  generation: V10,
  fromGeneration: V7,
};

/** Where a read scoped to `jurisdiction` goes: the generation and its index. */
const readTarget = async (jurisdiction: string) => {
  const target = await runInTransaction(
    async (tx) =>
      await readServingCorpusIndexTargetTx(tx, {
        family: "case_law",
        jurisdiction,
      }),
  );
  return target.isOk()
    ? { generation: target.value.serving.generation }
    : panic(`No read target for ${jurisdiction}`);
};

/** The engine and the registry hold what both generations show now. */
const proveBoth = async () => {
  await proveRoutes(V7);
  await proveRoutes(V10);
};

/**
 * v7 serves, v10 builds; both show the three decisions at epoch 1, every
 * route attested, proven and seeded.
 */
const readyShared = async () => {
  await register(V7, "serving");
  await register(V10, "building");
  for (const generation of [V7, V10] as const) {
    for (const n of [POL, CZE, SVK]) {
      // db-await-in-loop: fixture rows, in order
      await seedShown(generation, n, 1, JURISDICTION_OF[n]);
    }
    // db-await-in-loop: fixture steps, in order
    await attestGroups(generation);
    // db-await-in-loop: fixture steps, in order
    await proveRoutes(generation);
    // db-await-in-loop: fixture steps, in order
    await seedRoutes(generation);
  }
};

/**
 * v10 (serving) applies epoch 2 of decision `n`, which v7 was handed and has
 * not applied: v7 would serve the older copy.
 */
const v7Behind = async (n: typeof POL | typeof CZE | typeof SVK) => {
  await seedShown(V10, n, 2, JURISDICTION_OF[n]);
  await seedPending(V7, n, 2);
};

/** Stand a receipt of the flip v7 -> v10 recorded at `flippedAt`, with `evidence`. */
const standForwardReceipt = async (flippedAt: SQL, evidence: unknown) =>
  await db.execute(sql`
    WITH receipt AS (
      SELECT 'case_law'::text AS family, ${V7}::varchar AS from_generation,
        ${V10}::varchar AS to_generation, 'operator:test'::varchar AS actor,
        'test'::varchar AS reason, ${JSON.stringify(evidence)}::text::jsonb AS evidence,
        ${flippedAt} AS flipped_at
    )
    INSERT INTO ${corpusIndexGenerationFlips} (id, family, from_generation, to_generation, actor, reason, evidence, evidence_digest, flipped_at)
    SELECT gen_random_uuid(), family, from_generation, to_generation, actor, reason, evidence,
      ${corpusIndexGenerationFlipReceiptDigest({
        family: sql`receipt.family`,
        fromGeneration: sql`receipt.from_generation`,
        toGeneration: sql`receipt.to_generation`,
        actor: sql`receipt.actor`,
        reason: sql`receipt.reason`,
        flippedAt: sql`receipt.flipped_at`,
        evidence: sql`receipt.evidence`,
      })}, flipped_at
    FROM receipt
  `);

/** Move the family's serving generation the way a direct caller would. */
const serveDirectly = async (generation: Generation) =>
  await runInTransaction(
    async (tx) =>
      await setServingCorpusIndexGenerationTx(tx, {
        family: "case_law",
        generation,
      }),
  );

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

test("the fixture's two jurisdictions share one index in v7 and have their own in v10", () => {
  // Every claim below about a shared old index rests on this layout.
  expect(routeIn(V7, "CZE")).toBe(routeIn(V7, "SVK"));
  expect(routeIn(V10, "CZE")).not.toBe(routeIn(V10, "SVK"));
});

test("a forward flip recording a policy keeps its own parity: a regression of the kept jurisdiction still refuses", async () => {
  await readyShared();
  // v7 (serving) moves decision 2 to epoch 2; v10 was handed it, not applied.
  await seedShown(V7, CZE, 2, "CZE");
  await seedPending(V10, CZE, 2);
  await proveBoth();

  expect(refusalOf(await flip(V10, V7, KEEP_CZE))).toBe("parity:regressions");
  expect(await statuses()).toEqual({ [V7]: "serving", [V10]: "building" });
  expect(await pointers()).toEqual([]);
  expect(await db.select().from(corpusIndexGenerationFlips)).toEqual([]);
});

test("a wrong pair or a code both generations do not hold is refused before anything is read twice", async () => {
  await readyShared();
  const refused = async (policy: CorpusIndexFallbackPolicy) =>
    refusalOf(await prepare(request(V10, V7, policy)));

  expect(
    await refused({
      fromGeneration: V10,
      toGeneration: V7,
      keepOnNewer: ["CZE"],
    }),
  ).toBe("rollback_policy:pair_mismatch");
  expect(
    await refused({
      fromGeneration: "case_law_v8",
      toGeneration: V10,
      keepOnNewer: ["CZE"],
    }),
  ).toBe("rollback_policy:pair_mismatch");
  expect(await refused({ ...KEEP_CZE, keepOnNewer: ["XXX"] })).toBe(
    "rollback_policy:undeclared_jurisdiction",
  );
  // Never mapped to the declared code.
  expect(await refused({ ...KEEP_CZE, keepOnNewer: ["cze"] })).toBe(
    "rollback_policy:undeclared_jurisdiction",
  );
  expect(await refused({ ...KEEP_CZE, keepOnNewer: [] })).toBe(
    "rollback_policy:no_jurisdictions",
  );
  expect(await refused({ ...KEEP_CZE, keepOnNewer: ["CZE", "CZE"] })).toBe(
    "rollback_policy:duplicate_jurisdiction",
  );
  // The same request without a policy is not refused: each refusal above is
  // the policy's.
  expect((await prepare(request(V10, V7))).isOk()).toBe(true);
  expect(await db.select().from(corpusIndexGenerationFlips)).toEqual([]);
});

test("a fallback keeps the kept jurisdiction on the newer generation, and the one sharing its old index keeps full parity", async () => {
  await readyShared();
  const forward = requireFlipped(await flip(V10, V7, KEEP_CZE));
  expect(forward.evidence.rollbackPolicy).toEqual(KEEP_CZE);
  expect(forward.evidence.fallback).toBeNull();
  // A forward flip clears every pointer: v10 holds all jurisdictions itself.
  expect(await pointers()).toEqual([]);

  // v7 falls behind v10 on the kept Czech decision and on the Slovak one,
  // which shares v7's index with it.
  await v7Behind(CZE);
  await v7Behind(SVK);
  await proveBoth();

  const shared = await prepare(request(V7, V10));
  const sharedPlan = requirePlan(shared);
  expect(sharedPlan.fallback).toEqual({
    receiptId: forward.receiptId,
    keepOnNewer: ["CZE"],
  });
  const sharedRefused = await commit(sharedPlan);
  expect(refusalOf(sharedRefused)).toBe("parity:regressions");
  // Only the Slovak decision counts: the kept Czech one is not compared.
  const details = sharedRefused.isErr() ? sharedRefused.error.details : [];
  expect(details.some((line) => line.includes(entityId(SVK)))).toBe(true);
  expect(details.some((line) => line.includes(entityId(CZE)))).toBe(false);

  // v7 applies the Slovak change; the Czech one stays behind.
  await seedShown(V7, SVK, 2, "SVK");
  await proveBoth();
  const plan = requirePlan(await prepare(request(V7, V10)));
  // The routes readers reach afterwards: all of v7's (its shared index still
  // serves SVK), and v10's Czech index alone.
  expect(
    plan.proofs
      .filter(({ generation }) => generation === V10)
      .map(({ indexId }) => indexId),
  ).toEqual([routeIn(V10, "CZE")]);
  expect(plan.proofs.filter(({ generation }) => generation === V7)).not.toEqual(
    [],
  );
  expect(
    plan.documents.map(({ generation, indexId }) => [generation, indexId]),
  ).toEqual(
    plan.proofs.map(({ generation, indexId }) => [generation, indexId]),
  );

  const dry = await commit(plan, "dry_run");
  if (dry.isErr() || dry.value.type !== "checked") {
    return panic(`Expected the dry run to pass: ${refusalOf(dry)}`);
  }
  expect(await pointers()).toEqual([]);
  const back = requireFlipped(await commit(plan));

  expect(await statuses()).toEqual({ [V7]: "serving", [V10]: "building" });
  expect(await pointers()).toEqual([KEPT_POINTER]);
  // The dry run and the applied flip decided on the same evidence (each
  // reads its watermark off the clock it ran at).
  const { parity: dryParity, ...dryRest } = dry.value.evidence;
  const { parity: backParity, ...backRest } = back.evidence;
  expect({ ...dryRest, auditRun: backRest.auditRun }).toEqual(backRest);
  expect({ ...dryParity, watermark: backParity?.watermark }).toEqual(
    backParity ?? panic("a fallback has a parity reading"),
  );
  expect(back.evidence.fallback).toEqual({
    receiptId: forward.receiptId,
    keepOnNewer: ["CZE"],
    keptOn: V10,
  });
  // The receipt stores exactly that evidence.
  const stored = await db
    .select({ evidence: corpusIndexGenerationFlips.evidence })
    .from(corpusIndexGenerationFlips)
    .where(eq(corpusIndexGenerationFlips.id, back.receiptId));
  expect(stored).toEqual([{ evidence: back.evidence }]);
  // Prepared again, the flip has nothing left to do.
  const again = await prepare(request(V7, V10));
  expect(again.isOk() && again.value.type).toBe("already_serving");

  // Reads: the kept jurisdiction goes to v10's index, the one sharing its old
  // index stays on v7.
  expect(await readTarget("CZE")).toMatchObject({ generation: V10 });
  expect(await readTarget("SVK")).toMatchObject({ generation: V7 });
  expect(await readTarget("POL")).toMatchObject({ generation: V7 });
});

test("a second forward flip compares around the pinned jurisdiction, and a fallback with no policy of its own moves every jurisdiction", async () => {
  await readyShared();
  requireFlipped(await flip(V10, V7, KEEP_CZE));
  await v7Behind(CZE);
  await proveBoth();
  requireFlipped(await flip(V7, V10));
  expect(await pointers()).toEqual([KEPT_POINTER]);

  // v7 serves again with CZE pinned on v10. v10 falls behind v7 on the Czech
  // decision; v10 serves CZE now and after, so the forward flip does not
  // compare it. A Slovak regression on the shared old index still refuses.
  await seedShown(V7, CZE, 3, "CZE");
  await seedPending(V10, CZE, 3);
  await seedShown(V7, SVK, 2, "SVK");
  await seedPending(V10, SVK, 2);
  await proveBoth();
  expect(refusalOf(await flip(V10, V7))).toBe("parity:regressions");
  await seedShown(V10, SVK, 2, "SVK");
  await proveBoth();
  const second = requireFlipped(await flip(V10, V7));
  expect(second.evidence.pinnedOnCandidate).toEqual(["CZE"]);
  expect(second.evidence.rollbackPolicy).toBeNull();
  expect(await pointers()).toEqual([]);

  // That flip recorded no policy, so the next fallback is the latest flip's
  // reverse with none: CZE is compared and moves like every jurisdiction.
  await seedShown(V10, CZE, 5, "CZE");
  await seedPending(V7, CZE, 5);
  await proveBoth();
  expect(refusalOf(await flip(V7, V10))).toBe("parity:regressions");
  await seedShown(V7, CZE, 5, "CZE");
  await proveBoth();
  const back = requireFlipped(await flip(V7, V10));
  expect(back.evidence.fallback).toBeNull();
  expect(await pointers()).toEqual([]);
  expect(await readTarget("CZE")).toMatchObject({ generation: V7 });
});

test("the serving mutation keeps the kept jurisdiction for a direct caller too, and its generation cannot be retired or rebuilt while it serves it", async () => {
  await register(V7, "building");
  await register(V10, "serving");
  // The flip that made v10 serve, recorded past the retire keep window, with
  // its policy.
  await standForwardReceipt(sql`clock_timestamp() - interval '30 days'`, {
    rollbackPolicy: KEEP_CZE,
  });

  await serveDirectly(V7);
  expect(await statuses()).toEqual({ [V7]: "serving", [V10]: "building" });
  expect(await pointers()).toEqual([KEPT_POINTER]);

  const retire = await runInTransaction(
    async (tx) =>
      await readCorpusIndexRetireTx(tx, {
        family: "case_law",
        generation: V10,
      }),
  );
  expect(
    retire.isErr() &&
      `${retire.error.refusal.class}:${retire.error.refusal.reason}`,
  ).toBe("pointer:jurisdiction_serving");
  const rebuilt = await rejectionOf(
    runInTransaction(
      async (tx) =>
        await beginCorpusIndexGenerationRebuildTx(tx, {
          family: "case_law",
          generation: V10,
        }),
    ),
  );
  expect(rebuilt instanceof Error && rebuilt.message).toContain(
    "still serves CZE",
  );
  expect(await statuses()).toEqual({ [V7]: "serving", [V10]: "building" });

  // Served by v10 again, the pointer is gone and nothing holds v10 back.
  await serveDirectly(V10);
  expect(await pointers()).toEqual([]);
  // A policy for another pair does not apply: falling back from v10 to v7
  // under a receipt of v10 -> v7 keeps nothing.
  await db.delete(corpusIndexGenerationFlips).where(sql`true`);
  await standForwardReceipt(sql`clock_timestamp() - interval '30 days'`, {
    rollbackPolicy: { ...KEEP_CZE, fromGeneration: V10, toGeneration: V7 },
  });
  await serveDirectly(V7);
  expect(await pointers()).toEqual([]);
});
