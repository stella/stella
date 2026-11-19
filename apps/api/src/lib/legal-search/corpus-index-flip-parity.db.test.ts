import { panic, Result } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import type { Transaction } from "@/api/db/root";
import { corpusIndexGenerations } from "@/api/db/schema";
import {
  CORPUS_INDEX_FLIP_WALK_CAP,
  type CorpusIndexFlipParity,
  readCorpusIndexFlipParity,
} from "@/api/lib/legal-search/corpus-index-flip-parity";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const SERVING = "case_law_v7";
const CANDIDATE = "case_law_v10";

/** Each side's route, and the route a decision can have been applied to before it moved. */
const ROUTES = {
  serving: { wanted: "case_law_v7_cs_sk", moved: "case_law_v7_pol" },
  candidate: { wanted: "case_law_v10_cze", moved: "case_law_v10_pol" },
} as const;

const ENTITY_COUNT = 12;
const entityId = (index: number) =>
  `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;

/**
 * Instants the model writes, in minutes before the database clock. The read
 * exempts nothing older than `EXEMPT_MINUTES`, so `old` is before the
 * watermark and `recent` after it, each far from it.
 */
const EXEMPT_MINUTES = 100;
const AGES = { old: 150, recent: 10 } as const;
type Age = keyof typeof AGES;
const ago = (age: Age, plusSeconds = 0) =>
  `(clock_timestamp() - ${AGES[age]} * INTERVAL '1 minute' + ${plusSeconds} * INTERVAL '1 second')`;
const fingerprint = (epoch: number) => `lpad('${epoch}', 64, '0')`;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const run = async (statement: string): Promise<void> => {
  await client.query(statement);
};

const registerGeneration = (
  generation: "case_law_v7" | "case_law_v8" | "case_law_v9" | "case_law_v10",
  status: "serving" | "building" | "retiring",
) => ({
  family: "case_law" as const,
  generation,
  cluster: "q09" as const,
  manifestDigest: corpusIndexManifestDigest(CORPUS_INDEX_MANIFESTS[generation]),
  status,
});

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
});

beforeEach(async () => {
  await run(`TRUNCATE TABLE corpus_index_generations CASCADE`);
  await db
    .insert(corpusIndexGenerations)
    .values([
      registerGeneration("case_law_v7", "serving"),
      registerGeneration("case_law_v10", "building"),
      registerGeneration("case_law_v8", "retiring"),
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
  "cleanup_committed+claimed",
  "cleanup_stalled+claimed",
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
  | { type: "erase"; epochsBehind: number }
  | {
      type: "upsert";
      epochsBehind: number;
      moved: boolean;
      named: NamedStatus;
    };

type ModelSide = {
  applied: ModelApplied;
  work: WorkStatus;
  /** When the state was created, and when its current desired state was. */
  created: Age;
  desired: Age;
};

type ModelEntity = {
  /** Every active generation takes a change from one canonical counter. */
  epoch: number;
  /** Whether a decision is erased does not depend on the generation. */
  action: "upsert" | "erase";
  serving: ModelSide | null;
  candidate: ModelSide | null;
};

// Weighted towards a shown copy on both sides, so the rarer branches (a stale
// candidate copy, a recent change, a blocked candidate) come up in every run.
const appliedArbitrary: fc.Arbitrary<ModelApplied> = fc.oneof(
  { arbitrary: fc.constant({ type: "none" } as const), weight: 1 },
  {
    arbitrary: fc.record({
      type: fc.constant("erase" as const),
      epochsBehind: fc.integer({ min: 0, max: 2 }),
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      type: fc.constant("upsert" as const),
      epochsBehind: fc.integer({ min: 0, max: 2 }),
      moved: fc.constantFrom(false, false, false, true),
      named: fc.constantFrom(...NAMED_STATUSES),
    }),
    weight: 5,
  },
);

const ageArbitrary = fc.constantFrom<Age>("old", "recent");

const sideArbitrary: fc.Arbitrary<ModelSide> = fc.record({
  applied: appliedArbitrary,
  work: fc.constantFrom(...WORK_STATUSES),
  created: ageArbitrary,
  desired: ageArbitrary,
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

const COPY_OF: Record<NamedStatus, "intact" | "delete_in_flight" | "deleted"> =
  {
    applied: "intact",
    cleanup_pending: "intact",
    "cleanup_pending+claimed": "delete_in_flight",
    "cleanup_started+claimed": "delete_in_flight",
    "cleanup_committed+claimed": "delete_in_flight",
    "cleanup_stalled+claimed": "delete_in_flight",
    "settled+claimed": "deleted",
  };

/** The copy a reader of that generation is given, if any. */
const copyOf = (
  entity: ModelEntity,
  side: ModelSide,
): "intact" | "delete_in_flight" | "deleted" | "none" => {
  const { applied } = side;
  if (entity.action !== "upsert") {
    return "none";
  }
  if (applied.type === "erase") {
    return "deleted";
  }
  if (applied.type !== "upsert" || applied.moved) {
    return "none";
  }
  return COPY_OF[applied.named];
};

type ExpectedRegression = {
  entityId: string;
  route: string | null;
  kind: "not_shown" | "stale";
  servingEpoch: bigint;
  candidateEpoch: bigint | null;
};

type Outcome =
  | { type: "fine" }
  | { type: "exempt"; kind: "not_shown" | "stale" }
  | { type: "missing"; entityId: string }
  | { type: "regression"; regression: ExpectedRegression };

/** One decision as the brute-force oracle judges it. */
const expectedOutcome = (entity: ModelEntity, index: number): Outcome => {
  const { serving, candidate } = entity;
  if (serving === null) {
    return { type: "fine" };
  }
  // Any serving state that wants an upsert needs a candidate state, shown yet
  // or not: the serving generation may apply it at any moment.
  if (candidate === null) {
    return entity.action === "upsert"
      ? { type: "missing", entityId: entityId(index) }
      : { type: "fine" };
  }
  const servingCopy = copyOf(entity, serving);
  if (servingCopy !== "intact" && servingCopy !== "delete_in_flight") {
    return { type: "fine" };
  }
  const servingEpoch = appliedEpoch(entity, serving.applied);
  const candidateCopy = copyOf(entity, candidate);
  const candidateShown = candidateCopy === "intact";
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
  const kind = candidateShown ? "stale" : "not_shown";
  // Whatever route it sits in, a named copy proven gone or being deleted is
  // not work the candidate finishes by itself.
  const namedCopy = ((applied: ModelApplied) => {
    switch (applied.type) {
      case "erase":
        return "deleted";
      case "upsert":
        return COPY_OF[applied.named];
      case "none":
        return "none";
      default:
        applied satisfies never;
        return panic("Unhandled model applied state");
    }
  })(candidate.applied);
  const exempt =
    candidate.work === "eligible" &&
    namedCopy !== "deleted" &&
    namedCopy !== "delete_in_flight" &&
    (candidateShown
      ? candidate.desired === "recent"
      : serving.created === "recent");
  if (exempt) {
    return { type: "exempt", kind };
  }
  return {
    type: "regression",
    regression: {
      entityId: entityId(index),
      // A shown decision wants an upsert, so the candidate wants its route.
      route: ROUTES.candidate.wanted,
      kind,
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
    exempt: outcomes.filter(({ type }) => type === "exempt").length,
    outcomes,
  };
};

const revisionId = (generationIndex: number, index: number) =>
  `00000000-0000-4000-9${generationIndex}00-${String(index + 1).padStart(12, "0")}`;

/** The status-shape columns of a revision a state names, by its status. */
const namedRevisionColumns = (named: NamedStatus): Record<string, string> => {
  const applied = {
    append_started_at: ago("old", -2),
    append_committed_at: ago("old", -1),
    applied_at: ago("old"),
    expected_document_count: "1",
  };
  const queued = {
    ...applied,
    append_publish_barrier_at: ago("old"),
    cleanup_not_before: ago("old", 1),
  };
  const claimed = {
    ...queued,
    cleanup_started_at: ago("old", 2),
    cleanup_attempts: "1",
  };
  const committed = {
    ...claimed,
    delete_opstamp: "1",
    delete_task_created_at: ago("old", 2),
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
    case "cleanup_committed+claimed":
      return { status: "'cleanup_committed'", ...committed };
    case "cleanup_stalled+claimed":
      return { status: "'cleanup_stalled'", ...committed };
    case "settled+claimed":
      return {
        status: "'settled'",
        ...committed,
        settled_at: ago("old", 3),
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
      return `'${work}', clock_timestamp(), 1, 'append_transient', 'model failure'`;
    case "blocked":
      return `'${work}', NULL, 3, 'append_rejected', 'model failure'`;
    default:
      work satisfies never;
      return panic("Unhandled work status");
  }
};

const GENERATION_INDEX = {
  case_law_v7: 1,
  case_law_v10: 2,
  case_law_v8: 3,
} as const;

const writeSide = async (
  entity: ModelEntity,
  index: number,
  side: ModelSide,
  generation: keyof typeof GENERATION_INDEX,
  routes: { wanted: string; moved: string },
): Promise<void> => {
  const id = entityId(index);
  const { applied } = side;
  const desired =
    entity.action === "upsert"
      ? `'upsert', ${entity.epoch}, ${fingerprint(entity.epoch)}, '${routes.wanted}'`
      : `'erase', ${entity.epoch}, NULL, NULL`;
  let appliedValues = "NULL, NULL, NULL, false, NULL, NULL, NULL";
  if (applied.type === "erase") {
    appliedValues = `'erase', ${appliedEpoch(entity, applied)}, NULL, false, NULL, NULL, ${ago("old")}`;
  }
  if (applied.type === "upsert") {
    const epoch = appliedEpoch(entity, applied);
    const indexId = applied.moved ? routes.moved : routes.wanted;
    const revision = revisionId(GENERATION_INDEX[generation], index);
    const columns = namedRevisionColumns(applied.named);
    await run(`
      INSERT INTO corpus_index_projection_intents
        (id, family, generation, entity_id, epoch, fingerprint, index_id,
         ${Object.keys(columns).join(", ")})
      VALUES ('${revision}', 'case_law', '${generation}', '${id}', ${epoch},
        ${fingerprint(epoch)}, '${indexId}', ${Object.values(columns).join(", ")})
    `);
    appliedValues = `'upsert', ${epoch}, '${revision}', ${applied.named === "settled+claimed"}, ${fingerprint(epoch)}, '${indexId}', ${ago("old")}`;
  }
  await run(`
    INSERT INTO corpus_index_projection_states
      (family, generation, entity_id, created_at, desired_at,
       desired_action, desired_epoch, desired_fingerprint, desired_index_id,
       work_status, retry_not_before, failure_attempts, last_failure_kind, last_failure_message,
       applied_action, applied_epoch, applied_revision, applied_revision_settled,
       applied_fingerprint, applied_index_id, applied_at)
    VALUES ('case_law', '${generation}', '${id}', ${ago(side.created)}, ${ago(side.desired)},
      ${desired}, ${workColumns(side.work)}, ${appliedValues})
  `);
};

const clearProjection = async (): Promise<void> => {
  await run(`DELETE FROM corpus_index_projection_states`);
  await run(`DELETE FROM corpus_index_projection_intents`);
};

const writeModel = async (entities: readonly ModelEntity[]): Promise<void> => {
  await clearProjection();
  for (const [index, entity] of entities.entries()) {
    // db-await-in-loop: the fixture writes one decision's rows in model order
    if (entity.serving !== null) {
      await writeSide(entity, index, entity.serving, SERVING, ROUTES.serving);
    }
    // db-await-in-loop: as above, the candidate side of the same decision
    if (entity.candidate !== null) {
      await writeSide(
        entity,
        index,
        entity.candidate,
        CANDIDATE,
        ROUTES.candidate,
      );
    }
  }
};

type ReadOptions = {
  candidate?: string;
  pageBudget?: number;
  /** Runs inside the transaction with this ordinal, before its work. */
  beforeTransaction?: { ordinal: number; run: () => Promise<void> };
};

const readParity = async ({
  candidate = CANDIDATE,
  pageBudget = 1000,
  beforeTransaction,
}: ReadOptions = {}) => {
  let ordinal = 0;
  return await readCorpusIndexFlipParity({
    runInTransaction: async (work) => {
      ordinal += 1;
      if (beforeTransaction?.ordinal === ordinal) {
        await beforeTransaction.run();
      }
      return await db.transaction(
        async (tx) => await work(asTestRaw<Transaction>(tx)),
      );
    },
    family: "case_law",
    candidate,
    exemptMinutes: EXEMPT_MINUTES,
    coverage: { pageSize: 2, pageBudget, resumeFrom: null },
  });
};

const requireParity = (
  result: Awaited<ReturnType<typeof readParity>>,
): CorpusIndexFlipParity =>
  Result.isOk(result)
    ? result.value
    : panic(
        `Flip parity read failed: ${result.error.message}: ${String(
          result.error._tag === "CorpusIndexFlipParityReadError"
            ? result.error.cause
            : result.error.reason,
        )}`,
      );

const exactRegressions = (parity: CorpusIndexFlipParity) =>
  parity.regressions.type === "exact"
    ? parity.regressions
    : panic("Expected an exact regression reading");

/** A decision both generations hold, shown by the serving one since long ago. */
const shownBySince = (
  candidate: ModelSide,
  servingCreated: Age = "old",
): ModelEntity => ({
  epoch: 2,
  action: "upsert",
  serving: {
    work: "eligible",
    created: servingCreated,
    desired: "recent",
    applied: {
      type: "upsert",
      epochsBehind: 0,
      moved: false,
      named: "applied",
    },
  },
  candidate,
});

const candidateSide = (
  applied: ModelApplied,
  work: WorkStatus = "eligible",
  desired: Age = "old",
): ModelSide => ({ applied, work, created: "old", desired });

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
            const parity = requireParity(await readParity());
            const regressions = exactRegressions(parity);
            expect(
              regressions.sample.map(
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
            }
            expect(
              regressions.byRoute.map(
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
            expect(regressions.exempt).toBe(expected.exempt);
            expect(parity.coverage).toMatchObject({
              type: "complete",
              missing: expected.missing.length,
            });
            expect([...parity.coverage.sample].toSorted()).toEqual(
              expected.missing.toSorted(),
            );
            expect(parity.verdict.type).toBe(
              expected.missing.length + expected.regressions.length === 0
                ? "no_regression"
                : "regressions",
            );
          },
        ),
        { numRuns: 64 },
      );
    },
    propertyTestTimeout(300_000),
  );

  describe("the watermark exempts only what the candidate converges on by itself", () => {
    const judged = async (entity: ModelEntity) => {
      await writeModel([entity]);
      const regressions = exactRegressions(requireParity(await readParity()));
      return {
        regressions: regressions.byRoute.map(({ kind, count }) => [
          kind,
          count,
        ]),
        exempt: regressions.exempt,
        walked: regressions.walked,
      };
    };
    const walkedOnly = (walk: "pending" | "blocked" | "absent") => ({
      pending: 0,
      blocked: 0,
      absent: 0,
      atRisk: 0,
      [walk]: 1,
    });
    const neverApplied = { type: "none" } as const;
    const olderCopy = {
      type: "upsert",
      epochsBehind: 1,
      moved: false,
      named: "applied",
    } as const;

    test("a decision new after the watermark that the candidate has not applied yet is exempt", async () => {
      expect(
        await judged(shownBySince(candidateSide(neverApplied), "recent")),
      ).toEqual({ regressions: [], exempt: 1, walked: walkedOnly("pending") });
    });

    test("an old decision the candidate never applied is not exempt, however recently the serving generation re-applied it", async () => {
      expect(await judged(shownBySince(candidateSide(neverApplied)))).toEqual({
        regressions: [["not_shown", 1]],
        exempt: 0,
        walked: walkedOnly("pending"),
      });
    });

    test("a newer change the candidate was handed after the watermark is exempt", async () => {
      expect(
        await judged(
          shownBySince(candidateSide(olderCopy, "eligible", "recent")),
        ),
      ).toEqual({ regressions: [], exempt: 1, walked: walkedOnly("pending") });
    });

    test("a newer change the candidate was handed before the watermark is not exempt", async () => {
      expect(
        await judged(shownBySince(candidateSide(olderCopy, "eligible", "old"))),
      ).toEqual({
        regressions: [["stale", 1]],
        exempt: 0,
        walked: walkedOnly("pending"),
      });
    });

    test("a blocked candidate is never exempt, even for a decision new after the watermark", async () => {
      expect(
        await judged(
          shownBySince(
            candidateSide(neverApplied, "blocked", "recent"),
            "recent",
          ),
        ),
      ).toEqual({
        regressions: [["not_shown", 1]],
        exempt: 0,
        walked: walkedOnly("blocked"),
      });
    });

    test("a candidate copy proven gone is never exempt", async () => {
      expect(
        await judged(
          shownBySince(
            candidateSide(
              {
                type: "upsert",
                epochsBehind: 0,
                moved: false,
                named: "settled+claimed",
              },
              "eligible",
              "recent",
            ),
            "recent",
          ),
        ),
      ).toEqual({
        regressions: [["not_shown", 1]],
        exempt: 0,
        walked: walkedOnly("absent"),
      });
    });
  });

  test("a converged candidate copy with a delete in flight is found by the at-risk walk alone", async () => {
    await writeModel([
      shownBySince(
        candidateSide({
          type: "upsert",
          epochsBehind: 0,
          moved: false,
          named: "cleanup_started+claimed",
        }),
      ),
    ]);
    const regressions = exactRegressions(requireParity(await readParity()));
    expect(regressions).toMatchObject({
      walked: { pending: 0, blocked: 0, absent: 0, atRisk: 1 },
      byRoute: [
        { route: ROUTES.candidate.wanted, kind: "not_shown", count: 1 },
      ],
    });
  });

  test("a converged candidate copy whose delete settled is found by the proven-gone walk alone", async () => {
    await writeModel([
      shownBySince(
        candidateSide({
          type: "upsert",
          epochsBehind: 0,
          moved: false,
          named: "settled+claimed",
        }),
      ),
    ]);
    const regressions = exactRegressions(requireParity(await readParity()));
    expect(regressions).toMatchObject({
      walked: { pending: 0, blocked: 0, absent: 1, atRisk: 0 },
      byRoute: [
        { route: ROUTES.candidate.wanted, kind: "not_shown", count: 1 },
      ],
    });
  });

  test("a decision another generation holds is still missing from the candidate", async () => {
    const entity = shownBySince(
      candidateSide({
        type: "upsert",
        epochsBehind: 0,
        moved: false,
        named: "applied",
      }),
    );
    await clearProjection();
    await writeSide(
      entity,
      0,
      entity.serving ?? panic("fixture"),
      SERVING,
      ROUTES.serving,
    );
    // Converged and shown, but in a third generation, not the candidate.
    await writeSide(
      entity,
      0,
      entity.candidate ?? panic("fixture"),
      "case_law_v8",
      {
        wanted: "case_law_v8_cs_sk",
        moved: "case_law_v8_pol",
      },
    );
    const parity = requireParity(await readParity());
    expect(parity.coverage).toMatchObject({
      type: "complete",
      missing: 1,
      sample: [entityId(0)],
    });
    expect(parity.verdict).toEqual({
      type: "regressions",
      missing: 1,
      regressions: 0,
    });
  });

  test("a decision the serving generation has not applied yet still needs a candidate state", async () => {
    // Nothing serves it at the walk, but the serving generation may apply it
    // before the flip; with no candidate state, no candidate walk would see it.
    await writeModel([
      {
        epoch: 1,
        action: "upsert",
        serving: {
          work: "eligible",
          created: "old",
          desired: "old",
          applied: { type: "none" },
        },
        candidate: null,
      },
    ]);
    const parity = requireParity(await readParity());
    expect(parity.coverage).toMatchObject({
      type: "complete",
      walked: 1,
      missing: 1,
      sample: [entityId(0)],
    });
    expect(parity.verdict.type).toBe("regressions");
  });

  test("a decision seeded into the candidate between the coverage walk and the regression read is still reported", async () => {
    const entity = shownBySince(candidateSide({ type: "none" }));
    await clearProjection();
    await writeSide(
      entity,
      0,
      entity.serving ?? panic("fixture"),
      SERVING,
      ROUTES.serving,
    );
    // Transactions: the pair check, one coverage page (one state, under the
    // page size), then the regression read. The seed lands just before the
    // regression read, after the walk saw no candidate state.
    const parity = requireParity(
      await readParity({
        beforeTransaction: {
          ordinal: 3,
          run: async () => {
            await writeSide(
              entity,
              0,
              entity.candidate ?? panic("fixture"),
              CANDIDATE,
              ROUTES.candidate,
            );
          },
        },
      }),
    );
    expect(parity.coverage).toMatchObject({ type: "complete", missing: 1 });
    expect(parity.verdict.type).toBe("regressions");
  });

  test("a walk past its cap, on any walk, leaves the verdict undecided", async () => {
    for (const work of ["eligible", "blocked"] as const) {
      // db-await-in-loop: two cap cases, one per walk
      await clearProjection();
      // db-await-in-loop: as above
      await run(`
        INSERT INTO corpus_index_projection_states
          (family, generation, entity_id, desired_action, desired_epoch,
           desired_fingerprint, desired_index_id, work_status,
           failure_attempts, last_failure_kind, last_failure_message)
        SELECT 'case_law', '${CANDIDATE}',
          ('00000000-0000-4000-a000-' || lpad(n::text, 12, '0'))::uuid,
          'upsert', 1, ${fingerprint(1)}, '${ROUTES.candidate.wanted}',
          '${work}',
          ${work === "blocked" ? "3, 'append_rejected', 'cap fixture'" : "0, NULL, NULL"}
        FROM generate_series(1, ${CORPUS_INDEX_FLIP_WALK_CAP + 1}) AS n
      `);
      // db-await-in-loop: as above
      const parity = requireParity(await readParity());
      expect(parity.regressions.type).toBe("at_least");
      expect(parity.verdict).toMatchObject({
        type: "undecided",
        reason: "walk_capped",
      });
    }
    await clearProjection();
  });

  test("a coverage walk cut short by its page budget leaves the verdict undecided", async () => {
    await writeModel(
      [0, 1, 2].map(() =>
        shownBySince(
          candidateSide({
            type: "upsert",
            epochsBehind: 0,
            moved: false,
            named: "applied",
          }),
        ),
      ),
    );
    const parity = requireParity(await readParity({ pageBudget: 1 }));
    expect(parity.coverage).toMatchObject({
      type: "incomplete",
      walked: 2,
      next: { after: entityId(1) },
    });
    expect(parity.verdict).toMatchObject({
      type: "undecided",
      reason: "coverage_incomplete",
    });
    expect(requireParity(await readParity()).verdict).toEqual({
      type: "no_regression",
    });
  });

  test("a pair the read cannot compare exactly is refused", async () => {
    const refusal = async (candidate: string) => {
      const result = await readParity({ candidate });
      return Result.isError(result) &&
        result.error._tag === "CorpusIndexFlipPairRefusedError"
        ? result.error.reason
        : panic("Expected a refused pair");
    };
    expect(await refusal(SERVING)).toBe("same_generation");
    expect(await refusal("case_law_v8")).toBe("generation_not_active");
    await db
      .insert(corpusIndexGenerations)
      .values(registerGeneration("case_law_v9", "building"));
    expect(await refusal("case_law_v9")).toBe("partial_generation");
    await run(`
      INSERT INTO corpus_index_jurisdiction_serving
        (family, jurisdiction, generation, from_generation)
      VALUES ('case_law', 'CZE', 'case_law_v10', 'case_law_v7')
    `);
    expect(await refusal(CANDIDATE)).toBe("jurisdiction_serving_pointer");
    await run(`TRUNCATE TABLE corpus_index_generations CASCADE`);
    await db
      .insert(corpusIndexGenerations)
      .values(registerGeneration("case_law_v10", "building"));
    expect(await refusal(CANDIDATE)).toBe("no_serving_generation");
  });
});
