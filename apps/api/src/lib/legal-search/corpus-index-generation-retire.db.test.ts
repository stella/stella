/**
 * Retiring a corpus generation against a real PostgreSQL registry and the
 * real canonical writer: the decision and its refusals, the transition and
 * its receipt, the database refusing every projection write to a retired
 * generation, the paged history purge (resumed after a crash), and the
 * engine step deleting that generation's indexes and no other's. The
 * registry's terminal guard and the history delete guard are not installed
 * in the embedded database; `corpus-generation-retire.postgres.test.ts`
 * covers them.
 */

import { panic, Result } from "better-result";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, asc, eq, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerationFlips,
  corpusIndexGenerations,
  corpusIndexJurisdictionServing,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  systemAuditRuns,
} from "@/api/db/schema";
import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import { corpusIndexGenerationFlipReceiptDigest } from "@/api/lib/legal-search/corpus-index-generation-flip-receipt";
import {
  corpusIndexBelongsToGeneration,
  type CorpusIndexRetireEngine,
  deleteRetiredCorpusIndexGenerationIndexes,
  readCorpusIndexRetireTx,
  retireCorpusIndexGeneration,
} from "@/api/lib/legal-search/corpus-index-generation-retire";
import {
  beginCorpusIndexGenerationRebuildTx,
  type CorpusIndexRetiredHistoryPage,
  purgeRetiredCorpusIndexGenerationPageTx,
  registerCorpusIndexGenerationTx,
  setServingCorpusIndexGenerationTx,
} from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  advanceCorpusProjectionDesiredStateTx,
  ensureCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const SERVING = "case_law_v7";
const RETIRED = "case_law_v8";
const KEPT = "case_law_v9";
const TARGET = { family: "case_law", generation: RETIRED } as const;
const RECEIPT = { actor: "operator:test", reason: "never serves" } as const;
const FAR_PAST = new Date("2026-01-01T00:00:00.000Z");
const FAR_FUTURE = new Date("2099-01-01T00:00:00.000Z");

const SOURCE_ID = toSafeId<"caseLawSource">(
  "0198e331-e578-7000-8000-000000000a01",
);
const decisionId = (n: number) =>
  toSafeId<"caseLawDecision">(
    `0198e331-e578-7000-8000-000000000b${String(n).padStart(2, "0")}`,
  );
const intentId = (n: number) =>
  toSafeId<"corpusIndexProjectionIntent">(
    `0198e331-e578-7000-8000-000000000c${String(n).padStart(2, "0")}`,
  );

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const runInTransaction = async <Value>(
  operation: (tx: Transaction) => Promise<Value>,
): Promise<Value> =>
  await db.transaction(
    async (tx) => await operation(asTestRaw<Transaction>(tx)),
  );

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
});

afterAll(async () => {
  await client.close();
});

const reset = async () => {
  await db.execute(
    sql.raw(
      'TRUNCATE TABLE "corpus_index_projection_states", "corpus_index_projection_intents", "corpus_index_generation_flips", "corpus_index_jurisdiction_serving", "system_audit_runs", "case_law_decisions", "case_law_sources", "corpus_index_generations" CASCADE',
    ),
  );
};

beforeEach(reset);

const register = async (
  generation: keyof typeof CORPUS_INDEX_MANIFESTS,
  status: "building" | "serving",
) => {
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS[generation],
    ),
    status,
  });
};

const subjectOf = (n: number) =>
  ({ family: "case_law", entityId: decisionId(n) }) as const;

/**
 * `count` decisions, each projected by the real writer into every active
 * generation (v7 serving, v8 and v9 building), and for each one an
 * unfinished revision of v8 whose lease has long expired: the history a
 * generation that never served still holds.
 */
const seed = async (count: number) => {
  await db.insert(caseLawSources).values({
    id: SOURCE_ID,
    adapterKey: "generation-retire",
    name: "Generation retire",
  });
  await db.insert(caseLawDecisions).values(
    Array.from({ length: count }, (_, n) => ({
      id: decisionId(n),
      sourceId: SOURCE_ID,
      caseNumber: `${String(n + 1)} As 3/2008`,
      court: "Nejvyšší správní soud",
      country: "CZE",
      language: "cs",
      contentHash: "a".repeat(64),
    })),
  );
  await register(SERVING, "serving");
  await register(RETIRED, "building");
  await register(KEPT, "building");
  for (let n = 0; n < count; n += 1) {
    await canonicalWrite(n);
  }
  const states = await statesOf(RETIRED);
  await db.insert(corpusIndexProjectionIntents).values(
    states.map((state, n) => ({
      id: intentId(n),
      family: "case_law" as const,
      generation: RETIRED,
      entityId: state.entityId,
      epoch: state.desiredEpoch,
      fingerprint: state.desiredFingerprint ?? "f".repeat(64),
      indexId: state.desiredIndexId ?? `${RETIRED}_cs_sk`,
      status: "append_started" as const,
      leaseToken: intentId(n),
      leaseExpiresAt: FAR_PAST,
      appendStartedAt: FAR_PAST,
    })),
  );
};

/** One edit of the decision by a canonical writer, projected in the same transaction. */
const canonicalWrite = async (n: number) =>
  await runInTransaction(async (tx) => {
    await tx
      .update(caseLawDecisions)
      .set({ court: sql`${caseLawDecisions.court} || '.'` })
      .where(eq(caseLawDecisions.id, decisionId(n)));
    return await advanceCorpusProjectionDesiredStateTx(tx, subjectOf(n));
  });

const statesOf = async (generation: string) =>
  await db
    .select()
    .from(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.generation, generation))
    .orderBy(asc(corpusIndexProjectionStates.entityId));

const intentsOf = async (generation: string) =>
  await db
    .select({ id: corpusIndexProjectionIntents.id })
    .from(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.generation, generation));

/** Each decision's canonical projection epoch, by its id as states name it. */
const canonicalEpochs = async () =>
  new Map<string, bigint>(
    (
      await db
        .select({
          id: caseLawDecisions.id,
          epoch: caseLawDecisions.projectionEpoch,
        })
        .from(caseLawDecisions)
    ).map(({ id, epoch }) => [id, epoch]),
  );

const registryRow = async (generation: string) =>
  (
    await db
      .select()
      .from(corpusIndexGenerations)
      .where(eq(corpusIndexGenerations.generation, generation))
  ).at(0);

const retire = async () =>
  await retireCorpusIndexGeneration(runInTransaction, TARGET, RECEIPT);

const refusalOf = async (generation: string) => {
  const outcome = await retireCorpusIndexGeneration(
    runInTransaction,
    { family: "case_law", generation },
    RECEIPT,
  );
  return outcome.isErr()
    ? `${outcome.error.refusal.class}:${outcome.error.refusal.reason}`
    : outcome.value.type;
};

/** Walk the purge cursor to its end; returns the pages walked. */
const purgeAll = async (limit: number) => {
  let after: string | null = null;
  let pages = 0;
  for (;;) {
    const cursor: string | null = after;
    const page: CorpusIndexRetiredHistoryPage = await runInTransaction(
      async (tx) =>
        await purgeRetiredCorpusIndexGenerationPageTx(tx, TARGET, {
          after: cursor,
          limit,
        }),
    );
    if (page.last === null) {
      return pages;
    }
    pages += 1;
    after = page.last;
  }
};

const errorChain = (error: unknown): string => {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(" | ");
};

const failureOf = async (work: () => Promise<unknown>): Promise<string> => {
  const outcome = await Result.tryPromise({
    try: work,
    catch: (cause) => cause,
  });
  return outcome.isErr() ? errorChain(outcome.error) : "none";
};

test("retire moves a building generation to retired with its receipt, and from that commit no writer projects it", async () => {
  await seed(3);
  const before = await statesOf(RETIRED);
  expect(before).toHaveLength(3);

  const outcome = await retire();
  expect(outcome.isOk() && outcome.value.type).toBe("retired");
  expect(await registryRow(RETIRED)).toMatchObject({
    status: "retired",
    retireActor: RECEIPT.actor,
    retireReason: RECEIPT.reason,
  });
  expect((await registryRow(RETIRED))?.retiredAt).toBeInstanceOf(Date);
  expect(
    (
      await db
        .select({ counts: systemAuditRuns.counts })
        .from(systemAuditRuns)
        .where(eq(systemAuditRuns.actor, "system:corpus-generation-retire"))
    ).map(({ counts }) => counts),
  ).toEqual([
    { retired: 1, deletedIndexes: 0, deletedStates: 0, deletedIntents: 0 },
  ]);

  // Every decision changes again: the generations still owed keep up with
  // the canonical epoch, the retired one keeps exactly what it held.
  for (let n = 0; n < 3; n += 1) {
    expect((await canonicalWrite(n)).generationCount).toBe(2);
  }
  const epochs = await canonicalEpochs();
  for (const generation of [SERVING, KEPT]) {
    for (const state of await statesOf(generation)) {
      expect(state.desiredEpoch).toBe(epochs.get(state.entityId) ?? -1n);
    }
  }
  expect(await statesOf(RETIRED)).toEqual(before);

  // A single-generation writer naming it is refused, and so is any write the
  // database sees, whoever makes it.
  expect(
    await failureOf(
      async () =>
        await runInTransaction(
          async (tx) =>
            await ensureCorpusProjectionDesiredStateTx(
              tx,
              subjectOf(0),
              RETIRED,
            ),
        ),
    ),
  ).toContain("Active corpus generation is not registered");
  expect(
    await failureOf(
      async () =>
        await db
          .update(corpusIndexProjectionStates)
          .set({ retryNotBefore: FAR_FUTURE })
          .where(eq(corpusIndexProjectionStates.generation, RETIRED)),
    ),
  ).toContain("case_law/case_law_v8 is retired and takes no projection writes");
  expect(
    await failureOf(
      async () =>
        await db
          .update(corpusIndexProjectionIntents)
          .set({ leaseExpiresAt: FAR_FUTURE })
          .where(eq(corpusIndexProjectionIntents.generation, RETIRED)),
    ),
  ).toContain("case_law/case_law_v8 is retired and takes no projection writes");
  expect(await statesOf(RETIRED)).toEqual(before);

  // Retiring again reports the receipt and changes nothing.
  const again = await retire();
  expect(again.isOk() && again.value.type).toBe("already_retired");
  expect(
    again.isOk() && again.value.type === "already_retired"
      ? again.value.receipt?.retireActor
      : null,
  ).toBe(RECEIPT.actor);
});

test("a retired generation is never registered, rebuilt or served again", async () => {
  await seed(1);
  expect((await retire()).isOk()).toBe(true);
  const retiredRow = await registryRow(RETIRED);

  expect(
    await failureOf(
      async () =>
        await runInTransaction(
          async (tx) =>
            await registerCorpusIndexGenerationTx(tx, {
              family: "case_law",
              generation: RETIRED,
            }),
        ),
    ),
  ).toContain("is retired and cannot be registered again");
  // The rebuild (a Plane reset) starts from building only.
  expect(
    await failureOf(
      async () =>
        await runInTransaction(
          async (tx) => await beginCorpusIndexGenerationRebuildTx(tx, TARGET),
        ),
    ),
  ).toContain("Corpus generation rebuild requires building");
  expect(
    await failureOf(
      async () =>
        await runInTransaction(
          async (tx) => await setServingCorpusIndexGenerationTx(tx, TARGET),
        ),
    ),
  ).toContain("Corpus serving target is not reconciled");
  expect(await registryRow(RETIRED)).toEqual(retiredRow);
});

test("retire refuses the serving generation, a rebuild in progress, a flip's way back, a pointer, leased revisions and an unknown or mismatched registration", async () => {
  await seed(1);
  const registry = async () =>
    await db
      .select()
      .from(corpusIndexGenerations)
      .orderBy(asc(corpusIndexGenerations.generation));
  const untouched = await registry();

  expect(await refusalOf(SERVING)).toBe("registry:serving");
  expect(await refusalOf("case_law_v10")).toBe("registry:not_registered");

  // A flip that demoted v8 within the keep window keeps it as the way back;
  // one older than the window does not.
  const recordFlip = async (flippedAt: SQL) => {
    await db.execute(sql`
      WITH receipt AS (
        SELECT 'case_law'::text AS family, ${RETIRED}::varchar AS from_generation,
          ${SERVING}::varchar AS to_generation, 'operator:test'::varchar AS actor,
          'test'::varchar AS reason, '{}'::jsonb AS evidence,
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
  };
  await recordFlip(sql`${FAR_PAST.toISOString()}::timestamptz`);
  const decided = await runInTransaction(
    async (tx) => await readCorpusIndexRetireTx(tx, TARGET),
  );
  expect(decided.isOk() && decided.value.type).toBe("retire");
  await recordFlip(sql`clock_timestamp()`);
  expect(await refusalOf(RETIRED)).toBe("flip:keep_window");
  await db.delete(corpusIndexGenerationFlips).where(sql`true`);

  // A jurisdiction pointer that serves from v8, or erases from it.
  await db.insert(corpusIndexJurisdictionServing).values({
    family: "case_law",
    jurisdiction: "CZE",
    generation: KEPT,
    fromGeneration: RETIRED,
  });
  expect(await refusalOf(RETIRED)).toBe("pointer:jurisdiction_serving");
  await db.delete(corpusIndexJurisdictionServing).where(sql`true`);

  // A runner holding a live lease on a revision is writing to v8 now.
  await db
    .update(corpusIndexProjectionIntents)
    .set({ leaseExpiresAt: FAR_FUTURE })
    .where(eq(corpusIndexProjectionIntents.generation, RETIRED));
  expect(await refusalOf(RETIRED)).toBe("in_flight:leased_revisions");
  await db
    .update(corpusIndexProjectionIntents)
    .set({ leaseExpiresAt: FAR_PAST })
    .where(eq(corpusIndexProjectionIntents.generation, RETIRED));

  expect(await registry()).toEqual(untouched);

  // A rebuild in progress holds v9 as retiring.
  await runInTransaction(
    async (tx) =>
      await beginCorpusIndexGenerationRebuildTx(tx, {
        family: "case_law",
        generation: KEPT,
      }),
  );
  expect(await refusalOf(KEPT)).toBe("registry:rebuilding");

  // A registration whose manifest the code no longer declares.
  await db
    .update(corpusIndexGenerations)
    .set({ manifestDigest: "0".repeat(64) })
    .where(eq(corpusIndexGenerations.generation, RETIRED));
  expect(await refusalOf(RETIRED)).toBe("registry:contract_mismatch");
  expect((await registryRow(RETIRED))?.status).toBe("building");
});

test("the history purge deletes a retired generation's states and unfinished revisions, and resumes after a crash at any page", async () => {
  const DECISIONS = 7;
  const PAGE = 2;
  await seed(DECISIONS);
  // Before the retire the purge refuses.
  expect(await failureOf(async () => await purgeAll(PAGE))).toContain(
    "retired history purge requires a retired generation",
  );
  expect((await retire()).isOk()).toBe(true);
  const kept = {
    serving: await statesOf(SERVING),
    kept: await statesOf(KEPT),
  };
  const pages = Math.ceil(DECISIONS / PAGE);

  for (let crashAt = 0; crashAt <= pages; crashAt += 1) {
    await reset();
    await seed(DECISIONS);
    expect((await retire()).isOk()).toBe(true);
    // The walk dies at page `crashAt`: the page's transaction rolls back
    // and the cursor is lost with the process.
    let after: string | null = null;
    for (let page = 0; page < crashAt; page += 1) {
      const cursor: string | null = after;
      const purged: CorpusIndexRetiredHistoryPage = await runInTransaction(
        async (tx) =>
          await purgeRetiredCorpusIndexGenerationPageTx(tx, TARGET, {
            after: cursor,
            limit: PAGE,
          }),
      );
      after = purged.last;
    }
    const resumeAfter: string | null = after;
    expect(
      await failureOf(
        async () =>
          await runInTransaction(async (tx) => {
            await purgeRetiredCorpusIndexGenerationPageTx(tx, TARGET, {
              after: resumeAfter,
              limit: PAGE,
            });
            return panic("the process died mid-page");
          }),
      ),
    ).toContain("the process died mid-page");
    const left = (await statesOf(RETIRED)).length;
    expect(left).toBe(Math.max(0, DECISIONS - crashAt * PAGE));

    // The next run starts from the beginning and finds only what is left.
    expect(await purgeAll(PAGE)).toBe(Math.ceil(left / PAGE));
    expect(await statesOf(RETIRED)).toEqual([]);
    expect(await intentsOf(RETIRED)).toEqual([]);
    // Nothing of another generation is touched.
    expect((await statesOf(SERVING)).map(({ entityId }) => entityId)).toEqual(
      kept.serving.map(({ entityId }) => entityId),
    );
    expect((await statesOf(KEPT)).map(({ entityId }) => entityId)).toEqual(
      kept.kept.map(({ entityId }) => entityId),
    );
    expect(await purgeAll(PAGE)).toBe(0);
  }
});

type Step =
  | { kind: "write"; decision: number }
  | { kind: "retire" }
  | { kind: "purge"; limit: number };

const DECISION_COUNT = 3;

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant("write" as const),
    decision: fc.integer({ min: 0, max: DECISION_COUNT - 1 }),
  }),
  fc.record({ kind: fc.constant("retire" as const) }),
  fc.record({
    kind: fc.constant("purge" as const),
    limit: fc.integer({ min: 1, max: DECISION_COUNT }),
  }),
);

test(
  "canonical writes interleaved with retire and purge never leave a desired state the retired generation did not already hold",
  async () => {
    await assertProperty(
      "canonical writes interleaved with retire and purge never leave a desired state the retired generation did not already hold",
      fc.asyncProperty(
        fc.array(stepArb, { minLength: 1, maxLength: 10 }),
        async (steps) => {
          await reset();
          await seed(DECISION_COUNT);
          // What the retired generation held at its retire, by entity.
          let heldAtRetire: Map<
            SafeId<"caseLawDecision">,
            Awaited<ReturnType<typeof statesOf>>[number]
          > | null = null;
          for (const step of steps) {
            switch (step.kind) {
              case "write":
                await canonicalWrite(step.decision);
                break;
              case "retire": {
                const outcome = await retire();
                expect(outcome.isOk()).toBe(true);
                heldAtRetire ??= new Map(
                  (await statesOf(RETIRED)).map((state) => [
                    toSafeId<"caseLawDecision">(state.entityId),
                    state,
                  ]),
                );
                break;
              }
              case "purge": {
                const purged = await failureOf(
                  async () =>
                    await runInTransaction(
                      async (tx) =>
                        await purgeRetiredCorpusIndexGenerationPageTx(
                          tx,
                          TARGET,
                          { after: null, limit: step.limit },
                        ),
                    ),
                );
                expect(purged).toEqual(
                  heldAtRetire === null
                    ? expect.stringContaining(
                        "retired history purge requires a retired generation",
                      )
                    : "none",
                );
                break;
              }
              default:
                step satisfies never;
                panic("Unhandled step");
            }
            // Every generation still owed follows the canonical epoch.
            const epochs = await canonicalEpochs();
            for (const generation of [SERVING, KEPT]) {
              const states = await statesOf(generation);
              expect(states).toHaveLength(DECISION_COUNT);
              for (const state of states) {
                expect(state.desiredEpoch).toBe(
                  epochs.get(state.entityId) ?? -1n,
                );
              }
            }
            const retiredStates = await statesOf(RETIRED);
            if (heldAtRetire === null) {
              expect(retiredStates).toHaveLength(DECISION_COUNT);
              for (const state of retiredStates) {
                expect(state.desiredEpoch).toBe(
                  epochs.get(state.entityId) ?? -1n,
                );
              }
            } else {
              // Only rows it held, exactly as it held them; the purge may
              // have taken some.
              const held = heldAtRetire;
              for (const state of retiredStates) {
                expect(
                  held.get(toSafeId<"caseLawDecision">(state.entityId)),
                ).toEqual(state);
              }
            }
          }
          if (heldAtRetire !== null) {
            await purgeAll(DECISION_COUNT);
            expect(await statesOf(RETIRED)).toEqual([]);
            expect(await intentsOf(RETIRED)).toEqual([]);
          }
        },
      ),
      { numRuns: 30 },
    );
  },
  propertyTestTimeout(180_000),
);

type FakeEngine = CorpusIndexRetireEngine & {
  indexes: Set<string>;
  deleted: string[];
};

const fakeEngine = (
  indexIds: readonly string[],
  { failDeleteOf = null }: { failDeleteOf?: string | null } = {},
): FakeEngine => {
  const indexes = new Set(indexIds);
  const deleted: string[] = [];
  return {
    indexes,
    deleted,
    readPublishedSplitCounts: async ({ includes }) =>
      await Promise.resolve(
        Result.ok(
          [...indexes]
            .filter((indexId) => includes(indexId))
            .map((indexId) => ({ indexId, publishedSplits: 3 })),
        ),
      ),
    deleteIndex: async (indexId) => {
      if (indexId === failDeleteOf) {
        return await Promise.resolve(
          Result.err(
            new CorpusIndexError({
              message: "engine unavailable",
              status: 503,
            }),
          ),
        );
      }
      indexes.delete(indexId);
      deleted.push(indexId);
      return await Promise.resolve(Result.ok());
    },
  };
};

test("the engine step deletes every index of the retired generation and no index of another", async () => {
  const own = [
    "case_law_v8_cs_sk",
    "case_law_v8_eu",
    "case_law_v8_usa",
    // A route this release no longer declares is still this generation's.
    "case_law_v8_aut",
  ];
  const others = [
    "case_law_v80_cze",
    "case_law_v9_cze",
    "case_law_v10_cs_sk",
    "case_law_v7_cs_sk",
    "legislation_v8_cze",
    "case_law_v",
  ];
  const engine = fakeEngine([...others, ...own]);
  const deletion = await deleteRetiredCorpusIndexGenerationIndexes({
    engine,
    target: TARGET,
  });
  expect(deletion.isOk() && deletion.value.deleted.toSorted()).toEqual(
    own.toSorted(),
  );
  expect([...engine.indexes].toSorted()).toEqual(others.toSorted());
  // Again: nothing left to delete, nothing else touched.
  const again = await deleteRetiredCorpusIndexGenerationIndexes({
    engine,
    target: TARGET,
  });
  expect(again.isOk() && again.value.deleted).toEqual([]);
  expect([...engine.indexes].toSorted()).toEqual(others.toSorted());

  // A failed delete stops the step and names what was deleted before it.
  const failing = fakeEngine([...others, ...own], {
    failDeleteOf: "case_law_v8_eu",
  });
  const failed = await deleteRetiredCorpusIndexGenerationIndexes({
    engine: failing,
    target: TARGET,
  });
  expect(failed.isErr() && failed.error.message).toContain(
    "did not delete case_law_v8_eu",
  );
  expect(failing.deleted.every((indexId) => own.includes(indexId))).toBe(true);
});

test("a generation's index ids are never another registered generation's", () => {
  const generationArb = fc
    .tuple(
      fc.constantFrom("case_law", "legislation"),
      fc.integer({ min: 1, max: 2000 }),
    )
    .map(([family, version]) => `${family}_v${String(version)}`);
  assertProperty(
    "a generation's index ids are never another registered generation's",
    fc.property(
      generationArb,
      generationArb,
      fc.stringMatching(/^[a-z][a-z_]{0,8}$/u),
      (generation, other, route) => {
        const indexId = `${other}_${route}`;
        expect(corpusIndexBelongsToGeneration(generation, indexId)).toBe(
          generation === other,
        );
      },
    ),
    { numRuns: 200 },
  );
});

test("retire reads only what PostgreSQL holds for the target", async () => {
  await seed(1);
  // v9's own lease does not hold back v8.
  await db.insert(corpusIndexProjectionIntents).values({
    id: intentId(99),
    family: "case_law",
    generation: KEPT,
    entityId: decisionId(0),
    epoch: (await statesOf(KEPT)).at(0)?.desiredEpoch ?? 1n,
    fingerprint: "e".repeat(64),
    indexId: `${KEPT}_cze`,
    status: "append_started",
    leaseToken: intentId(99),
    leaseExpiresAt: FAR_FUTURE,
    appendStartedAt: FAR_PAST,
  });
  expect(await refusalOf(RETIRED)).toBe("retired");
  expect(
    (
      await db
        .select({ status: corpusIndexGenerations.status })
        .from(corpusIndexGenerations)
        .where(
          and(
            eq(corpusIndexGenerations.family, "case_law"),
            eq(corpusIndexGenerations.generation, KEPT),
          ),
        )
    ).at(0)?.status,
  ).toBe("building");
});
