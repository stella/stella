import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import { corpusIndexGenerations } from "@/api/db/schema";
import {
  CORPUS_INDEX_FLIP_WALK_CAP,
  type CorpusIndexFlipPair,
  type CorpusIndexFlipRegressionReading,
  readCorpusIndexFlipCoveragePageTx,
  readCorpusIndexFlipRegressionsTx,
  readCorpusIndexFlipWatermarkTx,
} from "@/api/lib/legal-search/corpus-index-flip-parity";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const PAIR = {
  family: "case_law",
  serving: "case_law_v7",
  candidate: "case_law_v10",
} as const satisfies CorpusIndexFlipPair;

/** Each side's route, and the route a decision can have been applied to before it moved. */
const ROUTES = {
  serving: { wanted: "case_law_v7_cs_sk", moved: "case_law_v7_pol" },
  candidate: { wanted: "case_law_v10_cze", moved: "case_law_v10_pol" },
} as const;

const ENTITY_COUNT = 12;
const entityId = (index: number) =>
  `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;

/** Ticks are seconds after the model's origin; the watermark sits at 100. */
const WATERMARK_TICK = 100;
const ORIGIN = Temporal.Instant.from("2026-07-01T00:00:00Z");
const WATERMARK = ORIGIN.add({ seconds: WATERMARK_TICK });
const at = (tick: number) =>
  `('2026-07-01T00:00:00Z'::timestamptz + ${tick} * INTERVAL '1 second')`;
const fingerprint = (epoch: number) => `lpad('${epoch}', 64, '0')`;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const run = async (statement: string): Promise<void> => {
  await client.query(statement);
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(corpusIndexGenerations).values([
    {
      family: "case_law",
      generation: "case_law_v7",
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS.case_law_v7,
      ),
      status: "serving",
    },
    {
      family: "case_law",
      generation: "case_law_v10",
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS.case_law_v10,
      ),
      status: "building",
    },
    {
      family: "case_law",
      generation: "case_law_v8",
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS.case_law_v8,
      ),
      status: "retiring",
    },
  ]);
});

afterAll(async () => {
  await client.close();
});

// The model: each generation's state of one decision, written down
// independently of the SQL that judges it.

const NAMED_STATUSES = [
  "applied",
  "cleanup_pending",
  "cleanup_pending+claimed",
  "cleanup_started+claimed",
  "settled+claimed",
] as const;
type NamedStatus = (typeof NAMED_STATUSES)[number];

const WORK_STATUSES = [
  "eligible",
  "retry_scheduled",
  "repair_scheduled",
  "blocked",
] as const;
type WorkStatus = (typeof WORK_STATUSES)[number];

type ModelApplied =
  | { type: "none" }
  | { type: "erase"; epochsBehind: number; tick: number }
  | {
      type: "upsert";
      epochsBehind: number;
      tick: number;
      moved: boolean;
      named: NamedStatus;
    };

type ModelSide = { applied: ModelApplied; work: WorkStatus };

type ModelEntity = {
  /** Every active generation takes a change at the same epoch. */
  epoch: number;
  /** Whether a decision is erased does not depend on the generation. */
  action: "upsert" | "erase";
  serving: ModelSide | null;
  candidate: ModelSide | null;
};

// Weighted towards a shown copy on both sides, so the rarer branches (a stale
// candidate copy, a copy past the watermark) come up in every run.
const appliedArbitrary: fc.Arbitrary<ModelApplied> = fc.oneof(
  { arbitrary: fc.constant({ type: "none" } as const), weight: 1 },
  {
    arbitrary: fc.record({
      type: fc.constant("erase" as const),
      epochsBehind: fc.integer({ min: 0, max: 2 }),
      tick: fc.constantFrom(50, WATERMARK_TICK, 150),
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      type: fc.constant("upsert" as const),
      epochsBehind: fc.integer({ min: 0, max: 2 }),
      tick: fc.constantFrom(50, WATERMARK_TICK, 150),
      moved: fc.constantFrom(false, false, false, true),
      named: fc.constantFrom(...NAMED_STATUSES),
    }),
    weight: 4,
  },
);

const sideArbitrary: fc.Arbitrary<ModelSide> = fc.record({
  applied: appliedArbitrary,
  work: fc.constantFrom(...WORK_STATUSES),
});

const entityArbitrary: fc.Arbitrary<ModelEntity> = fc.record({
  epoch: fc.integer({ min: 1, max: 3 }),
  action: fc.constantFrom(
    "upsert" as const,
    "upsert" as const,
    "erase" as const,
  ),
  serving: fc.option(sideArbitrary, { freq: 6 }),
  candidate: fc.option(sideArbitrary, { freq: 4 }),
});

const appliedEpoch = (entity: ModelEntity, applied: ModelApplied): number =>
  applied.type === "none"
    ? panic("Nothing applied has no epoch")
    : Math.max(1, entity.epoch - applied.epochsBehind);

/** What a reader of that generation is given; the serving side counts a copy at risk. */
const shows = (
  entity: ModelEntity,
  side: ModelSide | null,
  copyAtRisk: "counts" | "does_not_count",
): boolean => {
  if (side === null || entity.action !== "upsert") {
    return false;
  }
  const { applied } = side;
  if (applied.type !== "upsert" || applied.moved) {
    return false;
  }
  switch (applied.named) {
    case "applied":
    case "cleanup_pending":
      return true;
    case "cleanup_pending+claimed":
    case "cleanup_started+claimed":
      return copyAtRisk === "counts";
    case "settled+claimed":
      return false;
    default:
      applied.named satisfies never;
      return panic("Unhandled named status");
  }
};

type ExpectedRegression = {
  entityId: string;
  route: string | null;
  kind: "not_shown" | "stale";
  servingEpoch: bigint;
  candidateEpoch: bigint | null;
};

/** One decision as the brute-force oracle judges it. */
const expectedOutcome = (
  entity: ModelEntity,
  index: number,
):
  | { type: "fine" }
  | { type: "missing"; entityId: string }
  | { type: "regression"; regression: ExpectedRegression } => {
  const { serving, candidate } = entity;
  if (serving === null || !shows(entity, serving, "counts")) {
    return { type: "fine" };
  }
  if (candidate === null) {
    return { type: "missing", entityId: entityId(index) };
  }
  const servingApplied = serving.applied;
  if (servingApplied.type !== "upsert") {
    return panic("A shown decision has an applied upsert");
  }
  if (servingApplied.tick > WATERMARK_TICK) {
    return { type: "fine" };
  }
  const servingEpoch = appliedEpoch(entity, servingApplied);
  const candidateShown = shows(entity, candidate, "does_not_count");
  const candidateEpoch =
    candidate.applied.type === "none"
      ? null
      : appliedEpoch(entity, candidate.applied);
  if (
    candidateShown &&
    candidateEpoch !== null &&
    candidateEpoch >= servingEpoch
  ) {
    return { type: "fine" };
  }
  return {
    type: "regression",
    regression: {
      entityId: entityId(index),
      // A shown decision wants an upsert, so the candidate wants its route.
      route: ROUTES.candidate.wanted,
      kind: candidateShown ? "stale" : "not_shown",
      servingEpoch: BigInt(servingEpoch),
      candidateEpoch: candidateEpoch === null ? null : BigInt(candidateEpoch),
    },
  };
};

/** The brute-force oracle: every decision, both generations, no index. */
const expectedParity = (entities: readonly ModelEntity[]) => {
  const outcomes = entities.map(expectedOutcome);
  return {
    regressions: outcomes.flatMap((outcome) =>
      outcome.type === "regression" ? [outcome.regression] : [],
    ),
    missing: outcomes.flatMap((outcome) =>
      outcome.type === "missing" ? [outcome.entityId] : [],
    ),
  };
};

const revisionId = (generationIndex: number, index: number) =>
  `00000000-0000-4000-9${generationIndex}00-${String(index + 1).padStart(12, "0")}`;

/** The status-shape columns of a revision a state names, by its status. */
const namedRevisionColumns = (
  named: NamedStatus,
  tick: number,
): Record<string, string> => {
  const applied = {
    append_started_at: at(tick - 2),
    append_committed_at: at(tick - 1),
    applied_at: at(tick),
    expected_document_count: "1",
  };
  const queued = {
    ...applied,
    append_publish_barrier_at: at(tick),
    cleanup_not_before: at(tick + 1),
  };
  const claimed = {
    ...queued,
    cleanup_started_at: at(tick + 2),
    cleanup_attempts: "1",
  };
  switch (named) {
    case "applied":
      return { status: "'applied'", ...applied };
    case "cleanup_pending":
      return { status: "'cleanup_pending'", ...queued };
    case "cleanup_pending+claimed":
      return {
        status: "'cleanup_pending'",
        ...queued,
        cleanup_attempts: "1",
      };
    case "cleanup_started+claimed":
      return { status: "'cleanup_started'", ...claimed };
    case "settled+claimed":
      return {
        status: "'settled'",
        ...claimed,
        delete_opstamp: "1",
        delete_task_created_at: at(tick + 2),
        settled_at: at(tick + 3),
      };
    default:
      named satisfies never;
      return panic("Unhandled named status");
  }
};

const workColumns = (work: WorkStatus) => {
  switch (work) {
    case "eligible":
    case "repair_scheduled":
      return `'${work}', NULL, 0, NULL, NULL`;
    case "retry_scheduled":
      return `'${work}', ${at(200)}, 1, 'append_transient', 'model failure'`;
    case "blocked":
      return `'${work}', NULL, 3, 'append_rejected', 'model failure'`;
    default:
      work satisfies never;
      return panic("Unhandled work status");
  }
};

const writeSide = async (
  entity: ModelEntity,
  index: number,
  side: ModelSide,
  which: "serving" | "candidate",
): Promise<void> => {
  const generation = PAIR[which];
  const routes = ROUTES[which];
  const id = entityId(index);
  const { applied } = side;
  const desired =
    entity.action === "upsert"
      ? `'upsert', ${entity.epoch}, ${fingerprint(entity.epoch)}, '${routes.wanted}'`
      : `'erase', ${entity.epoch}, NULL, NULL`;
  let appliedValues = "NULL, NULL, NULL, false, NULL, NULL, NULL";
  if (applied.type === "erase") {
    appliedValues = `'erase', ${appliedEpoch(entity, applied)}, NULL, false, NULL, NULL, ${at(applied.tick)}`;
  }
  if (applied.type === "upsert") {
    const epoch = appliedEpoch(entity, applied);
    const indexId = applied.moved ? routes.moved : routes.wanted;
    const revision = revisionId(which === "serving" ? 1 : 2, index);
    const columns = namedRevisionColumns(applied.named, applied.tick);
    await run(`
      INSERT INTO corpus_index_projection_intents
        (id, family, generation, entity_id, epoch, fingerprint, index_id,
         ${Object.keys(columns).join(", ")})
      VALUES ('${revision}', '${PAIR.family}', '${generation}', '${id}', ${epoch},
        ${fingerprint(epoch)}, '${indexId}', ${Object.values(columns).join(", ")})
    `);
    appliedValues = `'upsert', ${epoch}, '${revision}', ${applied.named === "settled+claimed"}, ${fingerprint(epoch)}, '${indexId}', ${at(applied.tick)}`;
  }
  await run(`
    INSERT INTO corpus_index_projection_states
      (family, generation, entity_id,
       desired_action, desired_epoch, desired_fingerprint, desired_index_id,
       work_status, retry_not_before, failure_attempts, last_failure_kind, last_failure_message,
       applied_action, applied_epoch, applied_revision, applied_revision_settled,
       applied_fingerprint, applied_index_id, applied_at)
    VALUES ('${PAIR.family}', '${generation}', '${id}', ${desired}, ${workColumns(side.work)}, ${appliedValues})
  `);
};

const clearPair = async (): Promise<void> => {
  await run(`
    DELETE FROM corpus_index_projection_states
    WHERE family = 'case_law' AND generation IN ('case_law_v7', 'case_law_v10')
  `);
  await run(`
    DELETE FROM corpus_index_projection_intents
    WHERE family = 'case_law' AND generation IN ('case_law_v7', 'case_law_v10')
  `);
};

const writeModel = async (entities: readonly ModelEntity[]): Promise<void> => {
  await clearPair();
  for (const [index, entity] of entities.entries()) {
    // db-await-in-loop: the fixture writes one decision's rows in model order
    if (entity.serving !== null) {
      await writeSide(entity, index, entity.serving, "serving");
    }
    // db-await-in-loop: as above, the candidate side of the same decision
    if (entity.candidate !== null) {
      await writeSide(entity, index, entity.candidate, "candidate");
    }
  }
};

const readRegressions = async (
  pair: CorpusIndexFlipPair = PAIR,
): Promise<ReturnType<typeof readCorpusIndexFlipRegressionsTx>> =>
  await db.transaction(
    async (tx) =>
      await readCorpusIndexFlipRegressionsTx(asTestRaw<Transaction>(tx), {
        pair,
        watermark: WATERMARK,
      }),
  );

const requireReading = (
  result: Awaited<ReturnType<typeof readCorpusIndexFlipRegressionsTx>>,
): CorpusIndexFlipRegressionReading =>
  Result.isOk(result)
    ? result.value
    : panic(
        `Flip parity read failed: ${result.error.message}: ${String(
          result.error._tag === "CorpusIndexFlipParityReadError"
            ? result.error.cause
            : result.error.reason,
        )}`,
      );

/** Walk every serving index the model can have applied to, two copies a page. */
const readCoveragePage = async (servingIndexId: string, after: string | null) =>
  await db.transaction(
    async (tx) =>
      await readCorpusIndexFlipCoveragePageTx(asTestRaw<Transaction>(tx), {
        pair: PAIR,
        servingIndexId,
        after,
        limit: 2,
      }),
  );

const readMissing = async (): Promise<string[]> => {
  const missing: string[] = [];
  for (const servingIndexId of Object.values(ROUTES.serving)) {
    let after: string | null = null;
    for (;;) {
      // db-await-in-loop: a keyset walk; each page's cursor comes from the one before it
      const page = await readCoveragePage(servingIndexId, after);
      if (Result.isError(page)) {
        return panic(`Flip coverage read failed: ${page.error.message}`);
      }
      missing.push(...page.value.missing.map(({ entityId: id }) => id));
      if (page.value.next === null) {
        break;
      }
      after = page.value.next;
    }
  }
  return missing.toSorted();
};

const observedKinds = new Set<string>();

describe("corpus index flip parity", () => {
  test(
    "corpus-index.flip-parity-matches-oracle",
    async () => {
      await assertProperty(
        "corpus-index.flip-parity-matches-oracle",
        fc.asyncProperty(
          fc.array(entityArbitrary, {
            minLength: 1,
            maxLength: ENTITY_COUNT,
          }),
          async (entities) => {
            await writeModel(entities);
            const expected = expectedParity(entities);
            const reading = requireReading(await readRegressions());
            expect(reading.type).toBe("exact");
            expect(
              reading.sample.map(
                ({
                  entityId: id,
                  route,
                  kind,
                  servingEpoch,
                  candidateEpoch,
                }) => ({
                  entityId: id,
                  route,
                  kind,
                  servingEpoch,
                  candidateEpoch,
                }),
              ),
            ).toEqual(
              expected.regressions.toSorted((left, right) =>
                left.entityId < right.entityId ? -1 : 1,
              ),
            );
            const counted = new Map<string, number>();
            for (const { route, kind } of expected.regressions) {
              const key = `${route ?? ""}/${kind}`;
              counted.set(key, (counted.get(key) ?? 0) + 1);
              observedKinds.add(kind);
            }
            expect(
              reading.byRoute.map(
                ({ route, kind, count }): [string, number] => [
                  `${route ?? ""}/${kind}`,
                  count,
                ],
              ),
            ).toEqual(
              [...counted].toSorted(([left], [right]) =>
                left < right ? -1 : 1,
              ),
            );
            expect(await readMissing()).toEqual(expected.missing.toSorted());
            if (expected.missing.length > 0) {
              observedKinds.add("no_state");
            }
          },
        ),
        { numRuns: 64 },
      );
      // The generator must reach every kind, or the property proves less than
      // it claims.
      expect([...observedKinds].toSorted()).toEqual([
        "no_state",
        "not_shown",
        "stale",
      ]);
    },
    propertyTestTimeout(300_000),
  );

  test("a converged candidate copy whose delete settled is still a regression", async () => {
    // The candidate state looks done (applied equals desired, nothing pending),
    // so only the walk of proven-gone copies can find it.
    const entity: ModelEntity = {
      epoch: 2,
      action: "upsert",
      serving: {
        work: "eligible",
        applied: {
          type: "upsert",
          epochsBehind: 1,
          tick: 50,
          moved: false,
          named: "applied",
        },
      },
      candidate: {
        work: "eligible",
        applied: {
          type: "upsert",
          epochsBehind: 0,
          tick: 50,
          moved: false,
          named: "settled+claimed",
        },
      },
    };
    await writeModel([entity]);
    const reading = requireReading(await readRegressions());
    expect(reading).toMatchObject({
      type: "exact",
      walked: { pending: 0, blocked: 0, absent: 1, atRisk: 0 },
      byRoute: [
        { route: ROUTES.candidate.wanted, kind: "not_shown", count: 1 },
      ],
    });
  });

  test("a walk past its cap reports a lower bound, never an exact answer", async () => {
    await clearPair();
    // Every one of these candidate states still wants its first append.
    await run(`
      INSERT INTO corpus_index_projection_states
        (family, generation, entity_id, desired_action, desired_epoch,
         desired_fingerprint, desired_index_id)
      SELECT 'case_law', 'case_law_v10',
        ('00000000-0000-4000-a000-' || lpad(n::text, 12, '0'))::uuid,
        'upsert', 1, ${fingerprint(1)}, '${ROUTES.candidate.wanted}'
      FROM generate_series(1, ${CORPUS_INDEX_FLIP_WALK_CAP + 1}) AS n
    `);
    const reading = requireReading(await readRegressions());
    expect(reading.walked.pending).toBe(CORPUS_INDEX_FLIP_WALK_CAP + 1);
    expect(reading.type).toBe("at_least");
    await clearPair();
  });

  test("a pair the read cannot compare exactly is refused", async () => {
    const refusal = async (pair: CorpusIndexFlipPair) => {
      const result = await readRegressions(pair);
      return Result.isError(result) &&
        result.error._tag === "CorpusIndexFlipPairRefusedError"
        ? result.error.reason
        : panic("Expected a refused pair");
    };
    expect(await refusal({ ...PAIR, candidate: PAIR.serving })).toBe(
      "same_generation",
    );
    expect(await refusal({ ...PAIR, candidate: "case_law_v8" })).toBe(
      "generation_not_active",
    );
    expect(await refusal({ ...PAIR, candidate: "case_law_v9" })).toBe(
      "generation_not_active",
    );
    await run(`
      INSERT INTO corpus_index_jurisdiction_serving
        (family, jurisdiction, generation, from_generation)
      VALUES ('case_law', 'CZE', 'case_law_v10', 'case_law_v7')
    `);
    expect(await refusal(PAIR)).toBe("jurisdiction_serving_pointer");
    await run(`DELETE FROM corpus_index_jurisdiction_serving`);
  });

  test("the watermark is the database clock less the exempt minutes", async () => {
    // The database clock and this process's clock agree only to a tick of the
    // database's clock source, so the bound allows one second either way.
    const before = Temporal.Now.instant().subtract({ minutes: 20, seconds: 1 });
    const watermark = await db.transaction(
      async (tx) =>
        await readCorpusIndexFlipWatermarkTx(asTestRaw<Transaction>(tx), 20),
    );
    const after = Temporal.Now.instant()
      .subtract({ minutes: 20 })
      .add({ seconds: 1 });
    expect(Temporal.Instant.compare(watermark, before)).toBe(1);
    expect(Temporal.Instant.compare(watermark, after)).toBe(-1);
  });
});
