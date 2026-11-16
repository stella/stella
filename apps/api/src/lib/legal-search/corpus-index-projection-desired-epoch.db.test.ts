/**
 * What a desired epoch means, and what writing one may touch.
 *
 * A generation's desired state is current when it holds the content the
 * canonical row derives for that generation (action, fingerprint, index);
 * its epoch orders that generation's own revisions and may trail the
 * canonical row's epoch, never lead it. Every reader of this release decides
 * currency that way: reconciliation, the seeding of one generation, and the
 * builder's lease check. Every writer of this release still moves every
 * generation to the canonical epoch together, so each row it leaves is also
 * one the previous release's rule (desired epoch equal to the canonical
 * epoch) accepts.
 *
 * Writing the projection epoch is bookkeeping: it never moves the canonical
 * row's `updated_at`, the freshness sitemaps, change cursors and
 * compare-and-set tokens read.
 */
import { panic } from "better-result";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawRankingSignalChanges,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { drainCaseLawRankingSignalChanges } from "@/api/lib/legal-search/case-law-ranking-signal-drain";
import { citationAuthorityBucket } from "@/api/lib/legal-search/case-law-ranking-signals";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { bootstrapCorpusProjectionDesiredStateBatchTx } from "@/api/lib/legal-search/corpus-index-projection-bootstrap";
import { deriveCorpusIndexProjectionDescriptor } from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import {
  advanceCorpusProjectionDesiredStateTx,
  corpusProjectionDesiredStateHolds,
  ensureCorpusProjectionDesiredStateTx,
  lockActiveCorpusProjectionSourceByIdTx,
  reconcileCorpusProjectionDesiredStateTx,
  synchronizeLockedCaseLawProjectionBatchTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { readReservedCorpusProjectionMaterialsTx } from "@/api/lib/legal-search/corpus-index-projection-materials";
import { installCorpusProjectionSeedingGuard } from "@/api/tests/helpers/corpus-projection-seeding-guard";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const SOURCE_ID = toSafeId<"caseLawSource">(
  "0198e331-e578-7000-8000-000000000701",
);
const DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000702",
);
const LEGISLATION_SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-000000000703",
);
const LEGISLATION_DOCUMENT_ID = toSafeId<"legislationDocument">(
  "0198e331-e578-7000-8000-000000000704",
);
const INTENT_ID = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000705",
);
const LEASE_TOKEN = "0198e331-e578-7000-8000-000000000706";

/** Without ranking signals: a bucket move never changes its content. */
const PLAIN = "case_law_v7";
/** Writes ranking signals: a bucket move is its content. */
const SIGNALLED = "case_law_v10";
const GENERATIONS = [PLAIN, SIGNALLED] as const;

/** The canonical rows' freshness before anything here runs. */
const FRESHNESS = new Date("2026-01-01T00:00:00.000Z");
const DECISION_DATES = ["2020-01-01", "2021-06-30", "2022-12-31"] as const;
/** Authorities in three different buckets. */
const AUTHORITIES = [0, 3, 63] as const;

const subject = { family: "case_law", entityId: DECISION_ID } as const;
/** Terms that withdraw redistribution: every generation must erase. */
const REVOKED_DESCRIPTOR = {
  license: "restricted",
  attribution: null,
  allowsRedistribution: false,
  allowsDerivedAi: false,
} as const;
const legislationSubject = {
  family: "legislation",
  entityId: LEGISLATION_DOCUMENT_ID,
} as const;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const runInTransaction = async <T>(work: (tx: Transaction) => Promise<T>) =>
  await db.transaction(async (tx) => await work(asTestRaw<Transaction>(tx)));

const reset = async (): Promise<void> => {
  await db.delete(corpusIndexProjectionIntents).where(sql`true`);
  await db.delete(corpusIndexProjectionStates).where(sql`true`);
  await db.delete(caseLawRankingSignalChanges).where(sql`true`);
  await db.delete(caseLawDecisions).where(sql`true`);
  await db.delete(legislationDocuments).where(sql`true`);
  await db.delete(caseLawSources).where(sql`true`);
  await db.delete(legislationSources).where(sql`true`);
  await db.delete(corpusIndexGenerations).where(sql`true`);

  await db.insert(caseLawSources).values({
    id: SOURCE_ID,
    adapterKey: "projection-desired-epoch",
    name: "Projection desired epoch",
  });
  await db.insert(caseLawDecisions).values({
    id: DECISION_ID,
    sourceId: SOURCE_ID,
    caseNumber: "21 Cdo 1/2020",
    court: "Nejvyšší soud",
    country: "CZE",
    language: "cs",
    decisionDate: DECISION_DATES[0],
    contentHash: "a".repeat(64),
    textS3Key: "case-law/projection-desired-epoch.txt",
    updatedAt: FRESHNESS,
  });
  await db.insert(legislationSources).values({
    id: LEGISLATION_SOURCE_ID,
    adapterKey: "projection-desired-epoch",
    name: "Projection desired epoch",
  });
  await db.insert(legislationDocuments).values({
    id: LEGISLATION_DOCUMENT_ID,
    sourceId: LEGISLATION_SOURCE_ID,
    eli: "eli/cz/sb/2012/89",
    title: "Občanský zákoník",
    country: "CZE",
    language: "cs",
    contentHash: "b".repeat(64),
    updatedAt: FRESHNESS,
  });
  await db.insert(corpusIndexGenerations).values([
    ...GENERATIONS.map((generation) => ({
      family: "case_law" as const,
      generation,
      cluster: "q09" as const,
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS[generation],
      ),
      status: "building" as const,
    })),
    {
      family: "legislation",
      generation: "legislation_v2",
      cluster: "q09" as const,
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS.legislation_v2,
      ),
      status: "building",
    },
  ]);
  // Inserting the fixture may have queued it; each case starts empty.
  await db.delete(caseLawRankingSignalChanges).where(sql`true`);
};

// timeout: builds the PGlite schema from every migration.
beforeAll(async () => {
  client = await createTestPglite();
  await installCorpusProjectionSeedingGuard(client);
  db = drizzle({ client });
}, 120_000);

beforeEach(reset);

afterAll(async () => {
  await client.close();
});

const seedBothGenerations = async (): Promise<void> => {
  for (const generation of GENERATIONS) {
    await runInTransaction(
      async (tx) =>
        await ensureCorpusProjectionDesiredStateTx(tx, subject, generation),
    );
  }
};

const decisionRow = async () =>
  (
    await db
      .select({
        epoch: caseLawDecisions.projectionEpoch,
        updatedAt: caseLawDecisions.updatedAt,
      })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, DECISION_ID))
  ).at(0) ?? panic("The decision disappeared");

const legislationRow = async () =>
  (
    await db
      .select({
        epoch: legislationDocuments.projectionEpoch,
        updatedAt: legislationDocuments.updatedAt,
      })
      .from(legislationDocuments)
      .where(eq(legislationDocuments.id, LEGISLATION_DOCUMENT_ID))
  ).at(0) ?? panic("The document disappeared");

/** Every column of the decision's states, so "untouched" means byte-equal. */
const statesOf = async () =>
  await db
    .select()
    .from(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.entityId, DECISION_ID))
    .orderBy(asc(corpusIndexProjectionStates.generation));

const stateOf = async (generation: string) =>
  (await statesOf()).find((state) => state.generation === generation) ??
  panic(`No desired state in ${generation}`);

/** A sweep's authority write: it moves no public freshness of its own. */
const setAuthority = async (authority: number): Promise<void> => {
  await db
    .update(caseLawDecisions)
    .set({
      citationAuthority: authority,
      updatedAt: sql`${caseLawDecisions.updatedAt}`,
    })
    .where(eq(caseLawDecisions.id, DECISION_ID));
};

const synchronizeBatch = async (): Promise<void> => {
  await runInTransaction(async (tx) => {
    const lock =
      (await lockActiveCorpusProjectionSourceByIdTx(tx, {
        family: "case_law",
        sourceId: SOURCE_ID,
      })) ?? panic("No active case-law projection");
    await synchronizeLockedCaseLawProjectionBatchTx(tx, {
      lock,
      sourceId: SOURCE_ID,
      decisionIds: [DECISION_ID],
    });
  });
};

test("writing the projection epoch never moves the canonical row's freshness", async () => {
  // Bootstrap lifts a never-projected row from epoch 0.
  await runInTransaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(tx, {
        family: "case_law",
        generation: PLAIN,
        limit: 10,
      }),
  );
  expect(await decisionRow()).toEqual({ epoch: 1n, updatedAt: FRESHNESS });

  // Each writer below follows an edit that keeps the row's freshness, so
  // any move of `updated_at` is the projection write's own.
  const edit = async (tx: Transaction, decisionDate: string) => {
    await tx
      .update(caseLawDecisions)
      .set({ decisionDate, updatedAt: sql`${caseLawDecisions.updatedAt}` })
      .where(eq(caseLawDecisions.id, DECISION_ID));
  };
  await runInTransaction(async (tx) => {
    await edit(tx, DECISION_DATES[1]);
    await advanceCorpusProjectionDesiredStateTx(tx, subject);
  });
  expect(await decisionRow()).toEqual({ epoch: 2n, updatedAt: FRESHNESS });

  await runInTransaction(async (tx) => {
    await edit(tx, DECISION_DATES[2]);
    await reconcileCorpusProjectionDesiredStateTx(tx, subject);
  });
  expect(await decisionRow()).toEqual({ epoch: 3n, updatedAt: FRESHNESS });

  await setAuthority(AUTHORITIES[1]);
  expect(
    await drainCaseLawRankingSignalChanges({ runInTransaction }),
  ).toMatchObject({ reconciled: 1 });
  expect(await decisionRow()).toEqual({ epoch: 4n, updatedAt: FRESHNESS });

  await runInTransaction(async (tx) => {
    await edit(tx, DECISION_DATES[0]);
  });
  await synchronizeBatch();
  expect(await decisionRow()).toEqual({ epoch: 5n, updatedAt: FRESHNESS });

  await runInTransaction(
    async (tx) =>
      await ensureCorpusProjectionDesiredStateTx(
        tx,
        legislationSubject,
        "legislation_v2",
      ),
  );
  expect(await legislationRow()).toEqual({ epoch: 1n, updatedAt: FRESHNESS });
  await runInTransaction(async (tx) => {
    await tx
      .update(legislationDocuments)
      .set({
        title: "Nový občanský zákoník",
        updatedAt: sql`${legislationDocuments.updatedAt}`,
      })
      .where(eq(legislationDocuments.id, LEGISLATION_DOCUMENT_ID));
    await reconcileCorpusProjectionDesiredStateTx(tx, legislationSubject);
  });
  expect(await legislationRow()).toEqual({ epoch: 2n, updatedAt: FRESHNESS });
});

test("a generation whose desired epoch trails the canonical one is current to every reader", async () => {
  await seedBothGenerations();
  // The row a writer leaves when only the signalled generation changed: the
  // canonical epoch moved on with it, the plain generation kept its state.
  await db
    .update(caseLawDecisions)
    .set({ projectionEpoch: 2n, updatedAt: sql`${caseLawDecisions.updatedAt}` })
    .where(eq(caseLawDecisions.id, DECISION_ID));
  await db
    .update(corpusIndexProjectionStates)
    .set({ desiredEpoch: 2n })
    .where(eq(corpusIndexProjectionStates.generation, SIGNALLED));
  const trailing = await statesOf();
  expect(
    Object.fromEntries(
      trailing.map(({ generation, desiredEpoch }) => [
        generation,
        desiredEpoch,
      ]),
    ),
  ).toEqual({ [PLAIN]: 1n, [SIGNALLED]: 2n });

  // Reconciliation, single and batched, finds nothing to do.
  expect(
    await runInTransaction(
      async (tx) => await reconcileCorpusProjectionDesiredStateTx(tx, subject),
    ),
  ).toEqual({ epoch: 2n, changed: false, generationCount: 2 });
  await synchronizeBatch();
  expect(await statesOf()).toEqual(trailing);
  expect(await decisionRow()).toEqual({ epoch: 2n, updatedAt: FRESHNESS });

  // Seeding the generation again accepts it as it is.
  expect(
    await runInTransaction(
      async (tx) =>
        await ensureCorpusProjectionDesiredStateTx(tx, subject, PLAIN),
    ),
  ).toEqual({ created: false, epoch: 2n });

  // The builder takes a lease at the trailing epoch as current.
  const plain = await stateOf(PLAIN);
  const fingerprint =
    plain.desiredFingerprint ?? panic("The plain state holds no upsert");
  const indexId = plain.desiredIndexId ?? panic("The plain state has no index");
  // Leases are matched by token; expiry is the sweep's concern, not this read's.
  const leaseExpiresAt = new Date("2100-01-01T00:00:00.000Z");
  await db.insert(corpusIndexProjectionIntents).values({
    id: INTENT_ID,
    family: "case_law",
    generation: PLAIN,
    entityId: DECISION_ID,
    epoch: plain.desiredEpoch,
    fingerprint,
    indexId,
    status: "reserved",
    leaseToken: LEASE_TOKEN,
    leaseExpiresAt,
  });
  const materials = await runInTransaction(
    async (tx) =>
      await readReservedCorpusProjectionMaterialsTx(tx, {
        leases: [
          {
            intentId: INTENT_ID,
            family: "case_law",
            generation: PLAIN,
            entityId: DECISION_ID,
            epoch: plain.desiredEpoch,
            fingerprint,
            indexId,
            leaseToken: LEASE_TOKEN,
            leaseExpiresAt,
            appendMode: "batchable",
          },
        ],
      }),
  );
  expect(materials.rejected).toEqual([]);
  expect(materials.ready.map(({ lease }) => lease.intentId)).toEqual([
    INTENT_ID,
  ]);
  // The shared rule agrees with the builder: the content the builder derives
  // is what the trailing state holds, at any canonical epoch not behind it.
  const material = materials.ready.find((ready) => ready.family === "case_law");
  const derived =
    material?.family === "case_law"
      ? deriveCorpusIndexProjectionDescriptor(material.manifest, material.input)
      : panic("No ready case-law material");
  expect(corpusProjectionDesiredStateHolds(plain, 2n, derived)).toBe(true);
  expect(corpusProjectionDesiredStateHolds(plain, 1n, derived)).toBe(true);
  expect(corpusProjectionDesiredStateHolds(plain, 0n, derived)).toBe(false);

  // Trailing never hides drift: a content change moves every generation.
  await runInTransaction(async (tx) => {
    await tx
      .update(caseLawDecisions)
      .set({ decisionDate: DECISION_DATES[1] })
      .where(eq(caseLawDecisions.id, DECISION_ID));
    await reconcileCorpusProjectionDesiredStateTx(tx, subject);
  });
  expect(
    (await statesOf()).map(({ desiredEpoch, desiredFingerprint }) => ({
      desiredEpoch,
      changed: !trailing.some(
        (state) => state.desiredFingerprint === desiredFingerprint,
      ),
    })),
  ).toEqual([
    { desiredEpoch: 3n, changed: true },
    { desiredEpoch: 3n, changed: true },
  ]);
});

type Step =
  | { kind: "date"; date: number }
  | { kind: "signal"; authority: number }
  /** A bucket move as a writer that leaves the plain generation alone writes it. */
  | { kind: "signal_trailing"; authority: number }
  | { kind: "erase" }
  | { kind: "undo" };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant("date" as const),
    date: fc.integer({ min: 0, max: DECISION_DATES.length - 1 }),
  }),
  fc.record({
    kind: fc.constant("signal" as const),
    authority: fc.integer({ min: 0, max: AUTHORITIES.length - 1 }),
  }),
  fc.record({
    kind: fc.constant("signal_trailing" as const),
    authority: fc.integer({ min: 0, max: AUTHORITIES.length - 1 }),
  }),
  fc.constant({ kind: "erase" as const }),
  fc.constant({ kind: "undo" as const }),
);

/** The canonical inputs the steps move; mutated in place as they apply. */
type Model = { date: number; authority: number; erased: boolean };

/** What each generation's content depends on, and nothing else. */
const contentKey = (generation: (typeof GENERATIONS)[number], model: Model) => {
  if (model.erased) {
    return "erase";
  }
  const date = DECISION_DATES[model.date] ?? panic("No such date");
  if (generation === PLAIN) {
    return `upsert ${date}`;
  }
  const authority = AUTHORITIES[model.authority] ?? panic("No such authority");
  return `upsert ${date} bucket ${String(citationAuthorityBucket(authority))}`;
};

type PlainState = Awaited<ReturnType<typeof stateOf>>;

/**
 * Apply one step as its writer would. Returns whether it stamped the
 * decision's freshness: only an edit of the decision row itself does.
 */
const applyStep = async (
  step: Step,
  {
    model,
    stamp,
    plainBefore,
  }: { model: Model; stamp: Date; plainBefore: PlainState },
): Promise<{ stamped: boolean }> => {
  switch (step.kind) {
    case "date": {
      model.date = step.date;
      await runInTransaction(async (tx) => {
        await tx
          .update(caseLawDecisions)
          .set({ decisionDate: DECISION_DATES[step.date], updatedAt: stamp })
          .where(eq(caseLawDecisions.id, DECISION_ID));
        await reconcileCorpusProjectionDesiredStateTx(tx, subject);
      });
      return { stamped: true };
    }
    case "signal":
    case "signal_trailing": {
      model.authority = step.authority;
      await setAuthority(
        AUTHORITIES[step.authority] ?? panic("No such authority"),
      );
      await drainCaseLawRankingSignalChanges({ runInTransaction });
      if (step.kind === "signal_trailing") {
        // The plain generation's content cannot have moved, so a writer that
        // judges each generation alone leaves its state exactly as it was.
        const {
          generation,
          entityId: _entityId,
          family: _family,
          ...columns
        } = plainBefore;
        await db
          .update(corpusIndexProjectionStates)
          .set(columns)
          .where(eq(corpusIndexProjectionStates.generation, generation));
      }
      return { stamped: false };
    }
    case "erase":
    case "undo": {
      model.erased = step.kind === "erase";
      // The source's terms change; the decision row is not written.
      await runInTransaction(async (tx) => {
        await tx
          .update(caseLawSources)
          .set({
            descriptor: step.kind === "erase" ? REVOKED_DESCRIPTOR : null,
          })
          .where(eq(caseLawSources.id, SOURCE_ID));
        await reconcileCorpusProjectionDesiredStateTx(tx, subject);
      });
      return { stamped: false };
    }
    default:
      step satisfies never;
      return panic("Unhandled step");
  }
};

test(
  "a generation's desired content follows its own content, and no projection write moves the decision's freshness",
  async () => {
    await assertProperty(
      "a generation's desired content follows its own content, and no projection write moves the decision's freshness",
      fc.asyncProperty(
        fc.array(stepArb, { minLength: 1, maxLength: 8 }),
        async (steps) => {
          await reset();
          await seedBothGenerations();
          const world: {
            model: Model;
            freshness: Date;
            /** The plain state a writer left alone, until content moves. */
            trailing: PlainState | null;
          } = {
            model: { date: 0, authority: 0, erased: false },
            freshness: FRESHNESS,
            trailing: null,
          };
          // Each content key names exactly one desired content, per generation.
          const contentOfKey = new Map<string, string>();
          const keyOfContent = new Map<string, string>();
          const recordContent = async () => {
            for (const generation of GENERATIONS) {
              const state = await stateOf(generation);
              const key = `${generation} ${contentKey(generation, world.model)}`;
              const content = `${generation} ${state.desiredAction} ${String(state.desiredFingerprint)} ${String(state.desiredIndexId)}`;
              expect(contentOfKey.get(key) ?? content).toBe(content);
              expect(keyOfContent.get(content) ?? key).toBe(key);
              contentOfKey.set(key, content);
              keyOfContent.set(content, key);
            }
          };
          await recordContent();

          for (const [index, step] of steps.entries()) {
            const before = await decisionRow();
            const keysBefore = GENERATIONS.map((generation) =>
              contentKey(generation, world.model),
            );
            const plainBefore = await stateOf(PLAIN);
            // A content edit stamps its own freshness; nothing after it may.
            const stamp = new Date(FRESHNESS.getTime() + (index + 1) * 1000);
            const { stamped } = await applyStep(step, {
              model: world.model,
              stamp,
              plainBefore,
            });
            if (stamped) {
              world.freshness = stamp;
            }
            const keysAfter = GENERATIONS.map((generation) =>
              contentKey(generation, world.model),
            );
            const changed = keysAfter.some(
              (key, position) => key !== keysBefore[position],
            );
            if (step.kind === "signal_trailing") {
              world.trailing = plainBefore;
            } else if (changed) {
              world.trailing = null;
            }

            const after = await decisionRow();
            // The epoch moves once per change of any generation's content.
            expect(after.epoch).toBe(before.epoch + (changed ? 1n : 0n));
            expect(after.updatedAt).toEqual(world.freshness);
            await recordContent();

            const states = await statesOf();
            for (const state of states) {
              expect(state.desiredEpoch <= after.epoch).toBe(true);
              if (state.generation === PLAIN && world.trailing !== null) {
                // Left alone until a writer of this release changes content.
                expect(state).toEqual(world.trailing);
              } else {
                // What this release writes, the previous release's rule
                // (desired epoch equal to the canonical one) accepts.
                expect(state.desiredEpoch).toBe(after.epoch);
              }
            }

            // Reconciling again is a fixed point.
            expect(
              await runInTransaction(
                async (tx) =>
                  await reconcileCorpusProjectionDesiredStateTx(tx, subject),
              ),
            ).toMatchObject({ epoch: after.epoch, changed: false });
            expect(await statesOf()).toEqual(states);
            expect(await decisionRow()).toEqual(after);
          }
        },
      ),
      { numRuns: 40 },
    );
  },
  propertyTestTimeout(120_000),
);
