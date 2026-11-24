import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  type CorpusIndexProjectionSubject,
  CorpusIndexProjectionSubjectMissingError,
  type CorpusProjectionBatchRepairOutcome,
  ensureCorpusProjectionDesiredStateTx,
  reconcileCorpusProjectionDesiredStatesTx,
  reconcileCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { installCorpusProjectionCanonicalEpochGuard } from "@/api/tests/helpers/corpus-projection-canonical-epoch-guard";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const GENERATION = "case_law_v5";
const SOURCES = [
  toSafeId<"caseLawSource">("0198e331-e578-7000-8000-000000000a02"),
  toSafeId<"caseLawSource">("0198e331-e578-7000-8000-000000000a01"),
] as const;
const decisionId = (suffix: string) =>
  toSafeId<"caseLawDecision">(`0198e331-e578-7000-8000-000000000b${suffix}`);
/** Moved canonical content: re-derived to a new epoch. */
const MOVED = [decisionId("05"), decisionId("01"), decisionId("03")];
/** Unchanged canonical content: re-derived to the state it holds. */
const UNCHANGED = decisionId("04");
/** Withdrawn while a served copy is named: the repair is held. */
const HELD = decisionId("02");
/** Named but never stored. */
const MISSING = decisionId("06");
const STORED = [...MOVED, UNCHANGED, HELD];
const HELD_REVISION = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000c01",
);

const statements: string[] = [];

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await createTestPglite();
  await installCorpusProjectionCanonicalEpochGuard(client);
  db = drizzle({
    client,
    logger: {
      logQuery: (query) => {
        statements.push(query);
      },
    },
  });
});

afterAll(async () => {
  await client.close();
});

/**
 * Seeded desired states, then canonical rows written under them without
 * their sync, as a writer that skipped it would leave them: the material
 * read of every one of them is a canonical mismatch.
 */
const seedMismatches = async () => {
  await db.delete(corpusIndexProjectionStates).where(sql`true`);
  await db.delete(corpusIndexProjectionIntents).where(sql`true`);
  await db.delete(caseLawDecisions).where(sql`true`);
  await db.delete(caseLawSources).where(sql`true`);
  await db.delete(corpusIndexGenerations).where(sql`true`);
  await db.insert(caseLawSources).values(
    SOURCES.map((id, index) => ({
      id,
      adapterKey: `projection-batch-${String(index)}`,
      name: `Projection batch ${String(index)}`,
    })),
  );
  await db.insert(caseLawDecisions).values(
    STORED.map((id, index) => ({
      id,
      sourceId: SOURCES[index % SOURCES.length] ?? panic("Expected a source"),
      caseNumber: `${String(index)} As 1/2026`,
      court: "Nejvyšší správní soud",
      country: "CZE",
      language: "cs",
      contentHash: "a".repeat(64),
    })),
  );
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation: GENERATION,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS[GENERATION],
    ),
    status: "building",
  });
  for (const entityId of STORED) {
    // db-await-in-loop: one seeding transaction per decision, as writers do
    await db.transaction(
      async (tx) =>
        await ensureCorpusProjectionDesiredStateTx(
          asTestRaw<Transaction>(tx),
          { family: "case_law", entityId },
          GENERATION,
        ),
    );
  }
  const held =
    (
      await db
        .select()
        .from(corpusIndexProjectionStates)
        .where(eq(corpusIndexProjectionStates.entityId, HELD))
    ).at(0) ?? panic("Expected the held decision's state");
  const appliedAt = new Date("2026-08-24T00:00:00.000Z");
  await db.insert(corpusIndexProjectionIntents).values({
    id: HELD_REVISION,
    family: "case_law",
    generation: GENERATION,
    entityId: HELD,
    epoch: held.desiredEpoch,
    fingerprint: held.desiredFingerprint ?? panic("Expected an upsert"),
    indexId: held.desiredIndexId ?? panic("Expected an upsert"),
    status: "applied",
    appendStartedAt: appliedAt,
    appendCommittedAt: appliedAt,
    expectedDocumentCount: 1,
    appliedAt,
  });
  await db
    .update(corpusIndexProjectionStates)
    .set({
      appliedAction: "upsert",
      appliedEpoch: held.desiredEpoch,
      appliedRevision: HELD_REVISION,
      appliedFingerprint: held.desiredFingerprint,
      appliedIndexId: held.desiredIndexId,
      appliedAt,
    })
    .where(eq(corpusIndexProjectionStates.entityId, HELD));
  await db
    .update(caseLawDecisions)
    .set({ court: "Ústavní soud" })
    .where(inArray(caseLawDecisions.id, MOVED));
  await db
    .update(caseLawDecisions)
    .set({ contentHash: null })
    .where(eq(caseLawDecisions.id, HELD));
};

/** Everything a repair may move, without the instants it records. */
const projection = async () => ({
  decisions: await db
    .select({
      id: caseLawDecisions.id,
      projectionEpoch: caseLawDecisions.projectionEpoch,
    })
    .from(caseLawDecisions)
    .orderBy(asc(caseLawDecisions.id)),
  states: await db
    .select({
      entityId: corpusIndexProjectionStates.entityId,
      generation: corpusIndexProjectionStates.generation,
      desiredAction: corpusIndexProjectionStates.desiredAction,
      desiredEpoch: corpusIndexProjectionStates.desiredEpoch,
      desiredFingerprint: corpusIndexProjectionStates.desiredFingerprint,
      desiredIndexId: corpusIndexProjectionStates.desiredIndexId,
      workStatus: corpusIndexProjectionStates.workStatus,
      failureAttempts: corpusIndexProjectionStates.failureAttempts,
      appliedAction: corpusIndexProjectionStates.appliedAction,
      appliedRevision: corpusIndexProjectionStates.appliedRevision,
    })
    .from(corpusIndexProjectionStates)
    .orderBy(asc(corpusIndexProjectionStates.entityId)),
  intents: await db
    .select({
      id: corpusIndexProjectionIntents.id,
      status: corpusIndexProjectionIntents.status,
    })
    .from(corpusIndexProjectionIntents)
    .orderBy(asc(corpusIndexProjectionIntents.id)),
});

/** The page's subjects, in no particular order. */
const SUBJECTS: CorpusIndexProjectionSubject[] = [
  HELD,
  MISSING,
  ...MOVED,
  UNCHANGED,
].map((entityId) => ({ family: "case_law", entityId }));

const outcomeType = (outcome: CorpusProjectionBatchRepairOutcome) =>
  outcome.type === "reconciled"
    ? { type: outcome.type, changed: outcome.outcome.changed }
    : { type: outcome.type };

test("a page of mismatches re-derives in one transaction as one repair per subject would", async () => {
  await seedMismatches();
  const perRow = new Map<string, ReturnType<typeof outcomeType>>();
  for (const subject of SUBJECTS) {
    // db-await-in-loop: the per-subject reference path, one transaction each
    const outcome = await db
      .transaction(
        async (tx) =>
          await reconcileCorpusProjectionDesiredStateTx(
            asTestRaw<Transaction>(tx),
            subject,
          ),
      )
      .then(
        (written) =>
          outcomeType(
            written.isOk()
              ? { type: "reconciled", outcome: written.value }
              : { type: "held", hold: written.error },
          ),
        (error: unknown) =>
          error instanceof CorpusIndexProjectionSubjectMissingError
            ? outcomeType({ type: "missing" })
            : panic(`Unexpected repair failure: ${String(error)}`),
      );
    perRow.set(subject.entityId, outcome);
  }
  const expected = await projection();

  await seedMismatches();
  statements.length = 0;
  const batch = await db.transaction(
    async (tx) =>
      await reconcileCorpusProjectionDesiredStatesTx(
        asTestRaw<Transaction>(tx),
        SUBJECTS,
      ),
  );
  const batchStatements = [...statements];

  expect(
    new Map(
      [...batch].map(([entityId, outcome]) => [entityId, outcomeType(outcome)]),
    ),
  ).toEqual(perRow);
  expect(Object.fromEntries(perRow)).toEqual({
    [MOVED[0]]: { type: "reconciled", changed: true },
    [MOVED[1]]: { type: "reconciled", changed: true },
    [MOVED[2]]: { type: "reconciled", changed: true },
    [UNCHANGED]: { type: "reconciled", changed: false },
    [HELD]: { type: "held" },
    [MISSING]: { type: "missing" },
  });
  expect(await projection()).toEqual(expected);
  // The held subject kept its state and its served copy; the others moved.
  expect(
    (await projection()).states.find(({ entityId }) => entityId === HELD),
  ).toMatchObject({ desiredAction: "upsert", appliedRevision: HELD_REVISION });

  // One transaction: the moved subjects share one canonical epoch statement
  // and one desired-state statement, whatever their count.
  expect(
    batchStatements.filter((query) =>
      /^update "case_law_decisions" set "projection_epoch"/u.test(query),
    ),
  ).toHaveLength(1);
  expect(
    batchStatements.filter((query) =>
      /^insert into "corpus_index_projection_states"/u.test(query),
    ),
  ).toHaveLength(1);

  // Locks in the canonical writers' order, each kind once and by id.
  const position = (pattern: RegExp) => {
    const index = batchStatements.findIndex((query) => pattern.test(query));
    expect(index).toBeGreaterThanOrEqual(0);
    return index;
  };
  const order = [
    position(
      /from "case_law_sources".*order by "case_law_sources"\."id".*for share of "case_law_sources"/u,
    ),
    position(
      /from "case_law_decisions".*order by "case_law_decisions"\."id" asc.*for update/u,
    ),
    position(/from "case_law_decision_identifiers".*for share/u),
    position(/lock_corpus_projection_mutations_shared/u),
    position(
      /from "corpus_index_projection_states".*order by "corpus_index_projection_states"\."entity_id" asc.*for update/u,
    ),
  ];
  expect(order).toEqual(order.toSorted((left, right) => left - right));
});

test("a batch repair reaches a fixed point and holds only the subject at risk", async () => {
  await seedMismatches();
  const repair = async () =>
    await db.transaction(
      async (tx) =>
        await reconcileCorpusProjectionDesiredStatesTx(
          asTestRaw<Transaction>(tx),
          SUBJECTS,
        ),
    );
  await repair();
  const after = await projection();
  const again = await repair();
  expect(await projection()).toEqual(after);
  expect(
    [...again.values()].filter(
      (outcome) => outcome.type === "reconciled" && outcome.outcome.changed,
    ),
  ).toEqual([]);
  expect(again.get(HELD)?.type).toBe("held");
});
