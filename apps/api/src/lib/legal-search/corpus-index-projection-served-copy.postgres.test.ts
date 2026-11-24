import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import { settledWithin, waitFor } from "@stll/test-kit";

import {
  caseLawDecisions,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { decisionDocketColumns } from "@/api/handlers/case-law/ingestion/pipeline/decision-docket-columns";
import { toSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import { recordCorpusWithdrawalAuditEvent } from "@/api/lib/legal-search/corpus-index-job-audit";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexIdFromManifest,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { repairAppliedCorpusProjectionDriftTx } from "@/api/lib/legal-search/corpus-index-projection-census-store";
import {
  claimCorpusProjectionCleanupTx,
  recoverExpiredCorpusProjectionIntentsTx,
} from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import {
  advanceCorpusProjectionDesiredStateTx,
  reconcileCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { corpusIndexAppendPublishDelayMs } from "@/api/lib/legal-search/corpus-index-projection-engine";
import { advanceCorpusProjectionErasuresTx } from "@/api/lib/legal-search/corpus-index-projection-erasure-store";
import { isRecord } from "@/api/lib/type-guards";
import {
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

/** A manifest generation no other gated suite registers. */
/** The earlier release's publish fence: acceptance plus the generation's delay. */
const PUBLISH_DELAY = sql.raw(
  `(${corpusIndexAppendPublishDelayMs(CORPUS_INDEX_MANIFESTS.legislation_v3)} * interval '1 millisecond')`,
);
const GENERATION = "legislation_v3";
/** A second active generation of the family, for the tests that need one. */
const SIBLING = "legislation_v2";

type Fixture = {
  sourceId: string;
  indexId: string;
  entityId: string;
  revision: string;
};

type ServedCopy = {
  family: CorpusFamily;
  generation: string;
  entityId: string;
  indexId: string;
  revision: string;
};

/** One generation's state of the entity, serving one applied revision. */
const seedServedCopy = async (
  db: GatedTestDb,
  { family, generation, entityId, indexId, revision }: ServedCopy,
) => {
  const fingerprint = "a".repeat(64);
  await db.execute(sql`
    INSERT INTO corpus_index_projection_states (
      family, generation, entity_id, desired_action, desired_epoch,
      desired_fingerprint, desired_index_id, desired_at
    ) VALUES (
      ${family}, ${generation}, ${entityId}, 'upsert', 1, ${fingerprint},
      ${indexId}, statement_timestamp()
    )
  `);
  await db.execute(sql`
    INSERT INTO corpus_index_projection_intents (
      id, family, generation, entity_id, epoch, fingerprint, index_id, status,
      lease_token, lease_expires_at
    ) VALUES (
      ${revision}, ${family}, ${generation}, ${entityId}, 1, ${fingerprint},
      ${indexId}, 'reserved', ${Bun.randomUUIDv7()},
      clock_timestamp() + interval '5 minutes'
    )
  `);
  await db.execute(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'append_started',
        append_started_at = clock_timestamp() - interval '2 hours'
    WHERE id = ${revision}
  `);
  // Applied long enough ago that every publish fence of it has passed.
  await db.execute(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'append_committed',
        append_committed_at = clock_timestamp() - interval '2 hours',
        expected_document_count = 1
    WHERE id = ${revision}
  `);
  await db.execute(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'applied', lease_token = NULL, lease_expires_at = NULL,
        applied_at = clock_timestamp() - interval '2 hours'
    WHERE id = ${revision}
  `);
  await db.execute(sql`
    UPDATE corpus_index_projection_states
    SET applied_action = 'upsert', applied_epoch = 1,
        applied_revision = ${revision}, applied_fingerprint = ${fingerprint},
        applied_index_id = ${indexId}, applied_at = clock_timestamp()
    WHERE generation = ${generation} AND entity_id = ${entityId}
  `);
};

/**
 * One legislation document whose state serves one applied revision, written
 * in the statement shapes of the earlier release's append.
 */
const seed = async (db: GatedTestDb): Promise<Fixture> => {
  const suffix = Bun.randomUUIDv7().replaceAll("-", "").slice(-12);
  const indexId = `legislation_v3_served_${suffix}`;
  const sourceId = Bun.randomUUIDv7();
  const entityId = Bun.randomUUIDv7();
  const revision = Bun.randomUUIDv7();
  await db.execute(sql`
    INSERT INTO corpus_index_generations (
      family, generation, cluster, manifest_digest, status
    ) VALUES (
      'legislation', ${GENERATION}, 'q09',
      ${corpusIndexManifestDigest(CORPUS_INDEX_MANIFESTS.legislation_v3)},
      'building'
    )
  `);
  await db.execute(sql`
    INSERT INTO legislation_sources (id, adapter_key, name)
    VALUES (${sourceId}, ${`projection-served-${suffix}`}, 'Projection served copy')
  `);
  await db.execute(sql`
    INSERT INTO legislation_documents (
      id, source_id, eli, title, country, language, document_type, status,
      content_hash, projection_epoch
    ) VALUES (
      ${entityId}, ${sourceId}, ${`eli/cz/served/${suffix}`}, 'Act', 'CZE',
      'cs', 'act', 'current', ${"f".repeat(64)}, 1
    )
  `);
  await seedServedCopy(db, {
    family: "legislation",
    generation: GENERATION,
    entityId,
    indexId,
    revision,
  });
  return { sourceId, indexId, entityId, revision };
};

/** A canonical change through this release's desired-state writer. */
const writeCanonical = async (
  db: GatedTestDb,
  { entityId }: Fixture,
  contentHash: string | null,
) =>
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE legislation_documents SET content_hash = ${contentHash}
      WHERE id = ${entityId}
    `);
    return await advanceCorpusProjectionDesiredStateTx(tx, {
      family: "legislation",
      entityId: toSafeId<"legislationDocument">(entityId),
    });
  });

/** The earlier release's statement queueing a served revision for cleanup. */
const queueServedRevision = async (
  db: GatedTestDb,
  { revision }: Pick<Fixture, "revision">,
) => {
  await db.execute(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'cleanup_pending', lease_token = NULL, lease_expires_at = NULL,
        append_publish_barrier_at = append_committed_at + ${PUBLISH_DELAY},
        cleanup_not_before = GREATEST(
          clock_timestamp(),
          append_committed_at + ${PUBLISH_DELAY}
        ),
        last_error = NULL, updated_at = clock_timestamp()
    WHERE id = ${revision} AND status = 'applied'
  `);
};

/**
 * A replacement the earlier release prepared: the desired value moves on,
 * then the served revision is queued for cleanup, pointer kept.
 */
const previousPrepare = async (db: GatedTestDb, fixture: Fixture) => {
  await writeCanonical(db, fixture, "b".repeat(64));
  await queueServedRevision(db, fixture);
};

const claim = async (db: GatedTestDb, { indexId }: Fixture) =>
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    return await claimCorpusProjectionCleanupTx(tx, {
      family: "legislation",
      generation: GENERATION,
      indexId,
      limit: 16,
      leaseMs: 60_000,
    });
  });

type GatedTransaction = Parameters<
  Parameters<GatedTestDb["transaction"]>[0]
>[0];

type Held<T> = {
  /** The holding backend's pid, once `operation` has run. */
  holds: Promise<number>;
  release: () => void;
  done: Promise<T>;
};

/**
 * Run `operation` and keep its transaction open until released. `pid` is the
 * holding backend, so a test can see who waits on its locks. A failure before
 * the transaction holds rejects `holds` too, so a test waiting for it gets the
 * error instead of waiting forever.
 */
const holdOpen = <T>(
  db: GatedTestDb,
  operation: (tx: GatedTransaction) => Promise<T>,
): Held<T> => {
  const holds = Promise.withResolvers<number>();
  const release = Promise.withResolvers<undefined>();
  const done = db.transaction(async (tx) => {
    const value = await operation(tx);
    const backend = executedRows(
      await tx.execute(sql`SELECT pg_backend_pid() AS pid`),
    ).at(0);
    const pid = isRecord(backend) ? backend["pid"] : undefined;
    holds.resolve(
      typeof pid === "number" ? pid : panic("The holding backend has no pid"),
    );
    await release.promise;
    return value;
  });
  // A no-op once `holds` has resolved; `done` still rejects for its awaiter.
  void done.catch(holds.reject);
  return {
    holds: holds.promise,
    release: () => release.resolve(undefined),
    done,
  };
};

/**
 * Run `body` while `held` keeps its transaction open, then release it and
 * wait for it, and for every `competing` transaction started against it, to
 * end whatever `body` does: the suite's cleanup deletes rows these
 * transactions lock, so a failed assertion would otherwise hang the test or
 * tear its fixture down under a running writer instead of reporting. Returns
 * what the held transaction returned; the caller still awaits each competing
 * one for its own result.
 */
const whileHeld = async <T>(
  held: Held<T>,
  body: () => Promise<void>,
  competing: readonly Promise<unknown>[] = [],
): Promise<T> => {
  for (const transaction of competing) {
    // swallow-ok: marks the rejection handled until the caller awaits the same promise and asserts its outcome
    void transaction.catch(() => undefined);
  }
  try {
    await body();
  } finally {
    held.release();
    // When `body` failed, its error is the one to report.
    await Promise.allSettled([held.done, ...competing]);
  }
  return await held.done;
};

/**
 * The claim never waits on a row lock: it settles while another transaction
 * still holds the rows it reads. A claim that waited would hang here.
 */
const neverWaits = async <T>(claimed: Promise<T>) =>
  await settledWithin(claimed, {
    description: "a claim while another transaction holds its rows",
  });

/** Some backend is blocked behind the lock `holder` holds. */
const blockedBehind = async (db: GatedTestDb, holder: number) =>
  await waitFor(
    async () => {
      const blocked = executedRows(
        await db.execute(sql`
          SELECT pid FROM pg_stat_activity
          WHERE ${holder} = ANY(pg_blocking_pids(pid))
        `),
      );
      return blocked.length > 0 ? true : undefined;
    },
    { description: "a writer to wait behind the held state row" },
  );

const stateOf = async (db: GatedTestDb, { entityId }: Fixture) =>
  (
    await db
      .select({
        desiredAction: corpusIndexProjectionStates.desiredAction,
        appliedAction: corpusIndexProjectionStates.appliedAction,
        appliedRevision: corpusIndexProjectionStates.appliedRevision,
      })
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, entityId))
  ).at(0) ?? panic("No such state");

const statusOf = async (db: GatedTestDb, { revision }: Fixture) =>
  (
    await db
      .select({
        status: corpusIndexProjectionIntents.status,
        cleanupAttempts: corpusIndexProjectionIntents.cleanupAttempts,
      })
      .from(corpusIndexProjectionIntents)
      .where(
        eq(
          corpusIndexProjectionIntents.id,
          toSafeId<"corpusIndexProjectionIntent">(revision),
        ),
      )
  ).at(0) ?? panic("No such revision");

/**
 * Removes one generation's rows. Nonterminal projection history is deletable only
 * while the generation is retiring under the rebuild fence.
 */
const removeGeneration = async (
  db: GatedTestDb,
  generation: string,
  family: CorpusFamily = "legislation",
) => {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1937007986, 1)`);
    await tx.execute(sql`
      UPDATE corpus_index_generations SET status = 'retiring'
      WHERE family = ${family} AND generation = ${generation}
    `);
    await tx.execute(sql`
      DELETE FROM corpus_index_projection_states
      WHERE family = ${family} AND generation = ${generation}
    `);
    await tx.execute(sql`
      DELETE FROM corpus_index_projection_intents
      WHERE family = ${family} AND generation = ${generation}
    `);
  });
  await db.execute(sql`
    UPDATE corpus_index_generations SET status = 'retired'
    WHERE family = ${family} AND generation = ${generation}
  `);
  await db.execute(sql`
    DELETE FROM corpus_index_generations
    WHERE family = ${family} AND generation = ${generation}
  `);
};

const cleanUp = async (db: GatedTestDb, fixture: Fixture) => {
  await removeGeneration(db, GENERATION);
  await db.execute(sql`
    DELETE FROM legislation_documents WHERE id = ${fixture.entityId}
  `);
  await db.execute(sql`
    DELETE FROM legislation_sources WHERE id = ${fixture.sourceId}
  `);
};

/** Run with the same document served in the sibling generation too. */
const withSiblingCopy = async (
  db: GatedTestDb,
  { entityId }: Fixture,
  run: (sibling: ServedCopy) => Promise<void>,
) => {
  const sibling: ServedCopy = {
    family: "legislation",
    generation: SIBLING,
    entityId,
    indexId: "legislation_v2_cze",
    revision: Bun.randomUUIDv7(),
  };
  await db.execute(sql`
    INSERT INTO corpus_index_generations (
      family, generation, cluster, manifest_digest, status
    ) VALUES (
      'legislation', ${SIBLING}, 'q09',
      ${corpusIndexManifestDigest(CORPUS_INDEX_MANIFESTS.legislation_v2)},
      'building'
    )
  `);
  try {
    await seedServedCopy(db, sibling);
    await run(sibling);
  } finally {
    await removeGeneration(db, SIBLING);
  }
};

/** The repair writer, in the caller's transaction. */
const reconcileIn = async (tx: GatedTransaction, { entityId }: Fixture) =>
  await reconcileCorpusProjectionDesiredStateTx(tx, {
    family: "legislation",
    entityId: toSafeId<"legislationDocument">(entityId),
  });

const reconcile = async (db: GatedTestDb, fixture: Fixture) =>
  await db.transaction(async (tx) => await reconcileIn(tx, fixture));

/** Content the desired states do not hold yet, so a reconcile is owed. */
const driftCanonical = async (db: GatedTestDb, { entityId }: Fixture) => {
  await db.execute(sql`
    UPDATE legislation_documents SET content_hash = ${"9".repeat(64)}
    WHERE id = ${entityId}
  `);
};

/** Every column a held repair must leave alone. */
const snapshotOf = async (db: GatedTestDb, { entityId }: Fixture) => ({
  states: await db
    .select()
    .from(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.entityId, entityId))
    .orderBy(corpusIndexProjectionStates.generation),
  revisions: await db
    .select()
    .from(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.entityId, entityId))
    .orderBy(corpusIndexProjectionIntents.id),
  canonical: executedRows(
    await db.execute(
      sql`SELECT projection_epoch::text AS epoch FROM legislation_documents WHERE id = ${entityId}`,
    ),
  ),
});

const withTwoConnections = async (
  run: (
    first: GatedTestDb,
    second: GatedTestDb,
    fixture: Fixture,
    observer: GatedTestDb,
  ) => Promise<void>,
) => {
  if (databaseUrl === undefined) {
    panic("DATABASE_URL is required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const { db: first } = openClient();
    const { db: second } = openClient();
    const { db: observer } = openClient();
    const fixture = await seed(first);
    try {
      await run(first, second, fixture, observer);
    } finally {
      await cleanUp(first, fixture);
    }
  });
};

/** The case-law generation under test. */
const CASE_LAW = {
  family: "case_law",
  generation: "case_law_v11",
  indexId: corpusIndexIdFromManifest(
    CORPUS_INDEX_MANIFESTS.case_law_v11,
    "CZE",
  ),
} as const;

/** A projection change of the decision by this release's desired writer. */
const advanceDecision = async (db: GatedTestDb, { entityId }: Fixture) =>
  await db.transaction(
    async (tx) =>
      await advanceCorpusProjectionDesiredStateTx(tx, {
        family: CASE_LAW.family,
        entityId: toSafeId<"caseLawDecision">(entityId),
      }),
  );

/**
 * One decision whose named copy waits in the cleanup queue, more than one
 * desired change behind: the earlier release queued it at the first change and
 * this release's desired writer made the second.
 */
/** The rows `seedDriftedDecision` created, so a failed setup removes only them. */
type DriftedSeed = { generation: boolean; source: boolean; decision: boolean };

const seedDriftedDecision = async (
  db: GatedTestDb,
  fixture: Fixture,
  seeded: DriftedSeed,
): Promise<void> => {
  const suffix = fixture.sourceId.replaceAll("-", "").slice(-12);
  await db.execute(sql`
    INSERT INTO corpus_index_generations (
      family, generation, cluster, manifest_digest, status
    ) VALUES (
      ${CASE_LAW.family}, ${CASE_LAW.generation}, 'q09',
      ${corpusIndexManifestDigest(CORPUS_INDEX_MANIFESTS.case_law_v11)},
      'building'
    )
  `);
  seeded.generation = true;
  await db.execute(sql`
    INSERT INTO case_law_sources (id, adapter_key, name, enabled)
    VALUES (
      ${fixture.sourceId}, ${`superseded-copy-${suffix}`},
      'Superseded copy fixture', false
    )
  `);
  seeded.source = true;
  await db.insert(caseLawDecisions).values({
    id: toSafeId<"caseLawDecision">(fixture.entityId),
    sourceId: toSafeId<"caseLawSource">(fixture.sourceId),
    ...decisionDocketColumns({
      caseNumber: `1 As ${suffix}/2020`,
      caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      country: "CZE",
    }),
    court: "Nejvyšší správní soud",
    country: "CZE",
    language: "cs",
    contentHash: "f".repeat(64),
    projectionEpoch: 1n,
  });
  seeded.decision = true;
  await seedServedCopy(db, {
    family: CASE_LAW.family,
    generation: CASE_LAW.generation,
    entityId: fixture.entityId,
    indexId: fixture.indexId,
    revision: fixture.revision,
  });
  await advanceDecision(db, fixture);
  await queueServedRevision(db, fixture);
  await advanceDecision(db, fixture);
};

/** A withdrawal as its writer issues it: canonical row, erasure, trail. */
const withdrawIn = async (tx: GatedTransaction, { entityId }: Fixture) => {
  const decisionId = toSafeId<"caseLawDecision">(entityId);
  await tx.execute(sql`
    UPDATE case_law_decisions SET content_hash = NULL WHERE id = ${entityId}
  `);
  await advanceCorpusProjectionDesiredStateTx(tx, {
    family: CASE_LAW.family,
    entityId: decisionId,
  });
  await recordCorpusWithdrawalAuditEvent(tx, {
    decisionId,
    reason: "Stored payload no longer parses as a document",
  });
};

/** The undo of a withdrawal: the decision holds a document again. */
const restoreDocument = async (db: GatedTestDb, fixture: Fixture) => {
  await db.execute(sql`
    UPDATE case_law_decisions SET content_hash = ${"e".repeat(64)}
    WHERE id = ${fixture.entityId}
  `);
  await advanceDecision(db, fixture);
};

/**
 * A withdrawal and its undo as an earlier release left them: two desired
 * changes and the trail row in one transaction, the pointer kept. The trail
 * row comes last, as this release's writers record it.
 */
const previousWithdrawAndUndoIn = async (
  tx: GatedTransaction,
  { entityId }: Fixture,
) => {
  for (const desired of ["erase", "upsert"] as const) {
    // db-await-in-loop: the erasure, then its undo
    await tx.execute(sql`
      UPDATE case_law_decisions SET projection_epoch = projection_epoch + 1
      WHERE id = ${entityId}
    `);
    // db-await-in-loop: the erasure, then its undo
    await tx.execute(sql`
      UPDATE corpus_index_projection_states
      SET desired_action = ${desired}, desired_epoch = desired_epoch + 1,
          desired_fingerprint = ${desired === "upsert" ? "c".repeat(64) : null},
          desired_index_id = ${desired === "upsert" ? CASE_LAW.indexId : null},
          updated_at = statement_timestamp()
      WHERE entity_id = ${entityId}
    `);
  }
  await recordCorpusWithdrawalAuditEvent(tx, {
    decisionId: toSafeId<"caseLawDecision">(entityId),
    reason: "Stored payload no longer parses as a document",
  });
};

/** Every message of a failed statement, down its chain of causes. */
const messagesOf = (error: unknown): string =>
  error instanceof Error ? `${error.message}\n${messagesOf(error.cause)}` : "";

const claimDecisionIn = async (tx: GatedTransaction) =>
  await claimCorpusProjectionCleanupTx(tx, {
    family: CASE_LAW.family,
    generation: CASE_LAW.generation,
    indexId: CASE_LAW.indexId,
    limit: 16,
    leaseMs: 60_000,
  });

const claimDecision = async (db: GatedTestDb) =>
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    return await claimDecisionIn(tx);
  });

const withDriftedDecision = async (
  run: (
    first: GatedTestDb,
    second: GatedTestDb,
    fixture: Fixture,
    observer: GatedTestDb,
  ) => Promise<void>,
  {
    beforeSeed,
  }: {
    /**
     * Runs on the observer before anything is seeded, and returns what ends
     * whatever it left open; that runs before the fixture is removed.
     */
    beforeSeed?: (
      observer: GatedTestDb,
      fixture: Fixture,
    ) => Promise<() => Promise<void>>;
  } = {},
) => {
  if (databaseUrl === undefined) {
    panic("DATABASE_URL is required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const { db: first } = openClient();
    const { db: second } = openClient();
    const { db: observer } = openClient();
    const fixture: Fixture = {
      sourceId: Bun.randomUUIDv7(),
      indexId: CASE_LAW.indexId,
      entityId: Bun.randomUUIDv7(),
      revision: Bun.randomUUIDv7(),
    };
    const seeded: DriftedSeed = {
      generation: false,
      source: false,
      decision: false,
    };
    let settleBeforeSeed = async (): Promise<void> => undefined;
    try {
      if (beforeSeed !== undefined) {
        settleBeforeSeed = await beforeSeed(observer, fixture);
      }
      await seedDriftedDecision(first, fixture, seeded);
      await run(first, second, fixture, observer);
    } finally {
      await settleBeforeSeed();
      // Only what this setup created: a generation it found already there
      // fails the insert above and is left alone.
      if (seeded.generation) {
        await removeGeneration(first, CASE_LAW.generation, CASE_LAW.family);
      }
      if (seeded.decision) {
        await first.execute(
          sql`DELETE FROM case_law_decisions WHERE id = ${fixture.entityId}`,
        );
      }
      if (seeded.source) {
        await first.execute(
          sql`DELETE FROM case_law_sources WHERE id = ${fixture.sourceId}`,
        );
      }
    }
  });
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("the copy a projection state serves (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("the copy a projection state serves (postgres)", () => {
    test("a claim racing a desired erasure skips the held state and never restores the erased copy", async () => {
      await withTwoConnections(async (writer, claimer, fixture) => {
        await previousPrepare(writer, fixture);
        const erase = holdOpen(writer, async (tx) => {
          await tx.execute(sql`
            UPDATE legislation_documents SET content_hash = NULL
            WHERE id = ${fixture.entityId}
          `);
          return await advanceCorpusProjectionDesiredStateTx(tx, {
            family: "legislation",
            entityId: toSafeId<"legislationDocument">(fixture.entityId),
          });
        });
        await erase.holds;
        await whileHeld(erase, async () => {
          expect(await neverWaits(claim(claimer, fixture))).toMatchObject({
            leases: [],
            restoredIntentIds: [],
            skippedLocked: 1,
          });
        });

        const after = await claim(claimer, fixture);
        expect(after.restoredIntentIds).toEqual([]);
        expect(after.claimed.unserved).toBe(1);
        expect(await stateOf(claimer, fixture)).toMatchObject({
          desiredAction: "erase",
        });
      });
    });

    test("a desired erasure racing a restoring claim waits, then the erasure un-names the copy", async () => {
      await withTwoConnections(async (writer, claimer, fixture, observer) => {
        await previousPrepare(writer, fixture);
        const restore = holdOpen(
          claimer,
          async (tx) =>
            await claimCorpusProjectionCleanupTx(tx, {
              family: "legislation",
              generation: GENERATION,
              indexId: fixture.indexId,
              limit: 16,
              leaseMs: 60_000,
            }),
        );
        const holder = await restore.holds;
        const erase = writeCanonical(writer, fixture, null);
        const restored = await whileHeld(restore, async () => {
          expect(await blockedBehind(observer, holder)).toBe(true);
        }, [erase]);
        expect(restored.restoredIntentIds).toHaveLength(1);
        await erase;
        await writer.transaction(
          async (tx) =>
            await advanceCorpusProjectionErasuresTx(tx, {
              family: "legislation",
              generation: GENERATION,
              limit: 16,
            }),
        );
        expect(await stateOf(writer, fixture)).toEqual({
          desiredAction: "erase",
          appliedAction: null,
          appliedRevision: null,
        });
        expect((await statusOf(writer, fixture)).status).toBe(
          "cleanup_pending",
        );
      });
    });

    test("an erasure and its undo racing a restoring claim never re-serve the pre-erasure copy", async () => {
      await withTwoConnections(async (writer, claimer, fixture, observer) => {
        await previousPrepare(writer, fixture);
        const restore = holdOpen(
          claimer,
          async (tx) =>
            await claimCorpusProjectionCleanupTx(tx, {
              family: "legislation",
              generation: GENERATION,
              indexId: fixture.indexId,
              limit: 16,
              leaseMs: 60_000,
            }),
        );
        const holder = await restore.holds;
        const eraseThenUndo = (async () => {
          await writeCanonical(writer, fixture, null);
          await writeCanonical(writer, fixture, "e".repeat(64));
        })();
        await whileHeld(restore, async () => {
          expect(await blockedBehind(observer, holder)).toBe(true);
        }, [eraseThenUndo]);
        await eraseThenUndo;

        expect(await stateOf(writer, fixture)).toEqual({
          desiredAction: "upsert",
          appliedAction: null,
          appliedRevision: null,
        });
        expect(await statusOf(writer, fixture)).toEqual({
          status: "cleanup_pending",
          cleanupAttempts: 0,
        });
        const after = await claim(claimer, fixture);
        expect(after.restoredIntentIds).toEqual([]);
        expect(after.claimed.unserved).toBe(1);
      });
    });

    test("a claim racing a desired change decides after it, and holds nothing back", async () => {
      await withTwoConnections(async (writer, claimer, fixture) => {
        await previousPrepare(writer, fixture);
        const change = holdOpen(writer, async (tx) => {
          await tx.execute(sql`
            UPDATE legislation_documents SET content_hash = ${"d".repeat(64)}
            WHERE id = ${fixture.entityId}
          `);
          return await advanceCorpusProjectionDesiredStateTx(tx, {
            family: "legislation",
            entityId: toSafeId<"legislationDocument">(fixture.entityId),
          });
        });
        await change.holds;
        await whileHeld(change, async () => {
          expect(
            (await neverWaits(claim(claimer, fixture))).skippedLocked,
          ).toBe(1);
        });
        // Two desired changes with other content now separate the queued
        // copy from the desired state: no proof that the copy is the one to
        // serve, so it is claimed, not restored.
        const after = await claim(claimer, fixture);
        expect(after.restoredIntentIds).toEqual([]);
        expect(after.claimed.served_unproven).toBe(1);
      });
    });

    test("a claim racing the expired-lease sweep takes the swept revision and never holds it", async () => {
      await withTwoConnections(async (writer, claimer, fixture) => {
        await previousPrepare(writer, fixture);
        await writer.execute(sql`
          UPDATE corpus_index_projection_intents
          SET status = 'cleanup_started', lease_token = ${Bun.randomUUIDv7()},
              lease_expires_at = clock_timestamp() - interval '1 second',
              cleanup_started_at = clock_timestamp(),
              cleanup_attempts = cleanup_attempts + 1
          WHERE id = ${fixture.revision}
        `);
        const sweep = holdOpen(
          writer,
          async (tx) =>
            await recoverExpiredCorpusProjectionIntentsTx(tx, {
              family: "legislation",
              generation: GENERATION,
              limit: 16,
            }),
        );
        await sweep.holds;
        const swept = await whileHeld(sweep, async () => {
          expect((await neverWaits(claim(claimer, fixture))).leases).toEqual(
            [],
          );
        });
        expect(swept).toHaveLength(1);

        const after = await claim(claimer, fixture);
        expect(after.claimed.served_after_delete).toBe(1);
        expect(await statusOf(claimer, fixture)).toEqual({
          status: "cleanup_started",
          cleanupAttempts: 2,
        });
      });
    });

    test("a claim racing a drift repair never waits and takes the retired revision once the repair commits", async () => {
      await withTwoConnections(async (writer, claimer, fixture) => {
        const repair = holdOpen(
          writer,
          async (tx) =>
            await repairAppliedCorpusProjectionDriftTx(tx, {
              family: "legislation",
              generation: GENERATION,
              indexId: fixture.indexId,
              revisions: [
                toSafeId<"corpusIndexProjectionIntent">(fixture.revision),
              ],
            }),
        );
        await repair.holds;
        const repaired = await whileHeld(repair, async () => {
          expect((await neverWaits(claim(claimer, fixture))).leases).toEqual(
            [],
          );
        });
        expect(repaired).toBe(1);
        expect(await stateOf(claimer, fixture)).toEqual({
          desiredAction: "upsert",
          appliedAction: null,
          appliedRevision: null,
        });

        const after = await claim(claimer, fixture);
        expect(after.claimed.unserved).toBe(1);
      });
    });

    test("a claim that commits first keeps the copy it took: the repair goes through and takes nothing from it", async () => {
      await withTwoConnections(async (writer, claimer, fixture, observer) => {
        await previousPrepare(writer, fixture);
        // A second change: the claim cannot prove the copy, so it takes it.
        await writeCanonical(writer, fixture, "d".repeat(64));
        await driftCanonical(writer, fixture);
        const claiming = holdOpen(
          claimer,
          async (tx) =>
            await claimCorpusProjectionCleanupTx(tx, {
              family: "legislation",
              generation: GENERATION,
              indexId: fixture.indexId,
              limit: 16,
              leaseMs: 60_000,
            }),
        );
        const holder = await claiming.holds;
        const repair = reconcile(writer, fixture);
        const claimed = await whileHeld(claiming, async () => {
          expect(await blockedBehind(observer, holder)).toBe(true);
        }, [repair]);
        expect(claimed.claimed.served_unproven).toBe(1);

        const outcome = await repair;
        expect(outcome.isOk() && outcome.value).toMatchObject({
          changed: true,
          servedCopies: [],
        });
        expect(await statusOf(observer, fixture)).toEqual({
          status: "cleanup_started",
          cleanupAttempts: 1,
        });
        expect(await stateOf(observer, fixture)).toMatchObject({
          appliedRevision: fixture.revision,
        });
      });
    });

    test("a claim that commits after the first guard wins the copy: the repair holds and restores nothing", async () => {
      await withTwoConnections(async (writer, claimer, fixture, observer) => {
        await previousPrepare(writer, fixture);
        await driftCanonical(writer, fixture);
        // The earlier release's claim takes a revision without its state, so
        // it can land between the guard and the revision lock. This release's
        // claim cannot: it skips a state the writer holds, and reaching the
        // state first it restores the copy.
        const claiming = holdOpen(
          claimer,
          async (tx) =>
            await tx.execute(sql`
              UPDATE corpus_index_projection_intents
              SET status = 'cleanup_started', lease_token = ${Bun.randomUUIDv7()},
                  lease_expires_at = clock_timestamp() + interval '1 minute',
                  cleanup_started_at = clock_timestamp(),
                  cleanup_attempts = cleanup_attempts + 1,
                  updated_at = clock_timestamp()
              WHERE id = ${fixture.revision} AND status = 'cleanup_pending'
            `),
        );
        const holder = await claiming.holds;
        const repair = reconcile(writer, fixture);
        await whileHeld(claiming, async () => {
          // The guard read the copy as restorable; its row lock waits.
          expect(await blockedBehind(observer, holder)).toBe(true);
        }, [repair]);

        const outcome = await repair;
        if (outcome.isOk()) {
          panic("Expected the repair to be held");
        }
        expect(outcome.error.copies).toEqual([
          {
            generation: GENERATION,
            entityId: fixture.entityId,
            outcome: "held",
            risk: "restorable_cleanup",
          },
        ]);
        expect(await statusOf(observer, fixture)).toEqual({
          status: "cleanup_started",
          cleanupAttempts: 1,
        });
        // Held for that one race: the next repair finds nothing to protect.
        expect((await reconcile(writer, fixture)).isOk()).toBe(true);
      });
    });

    test("a restoring claim that commits first leaves the repair a current copy", async () => {
      await withTwoConnections(async (writer, claimer, fixture) => {
        await previousPrepare(writer, fixture);
        await driftCanonical(writer, fixture);
        expect((await claim(claimer, fixture)).restoredIntentIds).toHaveLength(
          1,
        );
        const outcome = await reconcile(writer, fixture);
        expect(outcome.isOk() && outcome.value.servedCopies).toEqual([
          {
            generation: GENERATION,
            entityId: fixture.entityId,
            outcome: "already_current",
          },
        ]);
      });
    });

    test("a repair that commits first restores the copy, and no claim deletes it", async () => {
      await withTwoConnections(async (writer, claimer, fixture) => {
        await previousPrepare(writer, fixture);
        await driftCanonical(writer, fixture);
        const repair = holdOpen(
          writer,
          async (tx) => await reconcileIn(tx, fixture),
        );
        await repair.holds;
        const outcome = await whileHeld(repair, async () => {
          expect(await neverWaits(claim(claimer, fixture))).toMatchObject({
            leases: [],
            restoredIntentIds: [],
            skippedLocked: 1,
          });
        });
        expect(outcome.isOk() && outcome.value.servedCopies).toEqual([
          {
            generation: GENERATION,
            entityId: fixture.entityId,
            outcome: "restored",
          },
        ]);

        expect(await claim(claimer, fixture)).toMatchObject({
          leases: [],
          restoredIntentIds: [],
          skippedLocked: 0,
        });
        expect(await statusOf(claimer, fixture)).toEqual({
          status: "applied",
          cleanupAttempts: 0,
        });
      });
    });

    test("a sibling generation at risk only at the second guard rolls the restore back", async () => {
      await withTwoConnections(async (writer, claimer, fixture, observer) => {
        await withSiblingCopy(observer, fixture, async (sibling) => {
          await previousPrepare(writer, fixture);
          await driftCanonical(writer, fixture);
          const before = await snapshotOf(observer, fixture);
          // Holding the queued revision stops the writer past its first
          // guard, before it restores.
          const stopped = holdOpen(
            claimer,
            async (tx) =>
              await tx.execute(sql`
                SELECT id FROM corpus_index_projection_intents
                WHERE id = ${fixture.revision} FOR UPDATE
              `),
          );
          const holder = await stopped.holds;
          const repair = reconcile(writer, fixture);
          await whileHeld(stopped, async () => {
            expect(await blockedBehind(observer, holder)).toBe(true);
            expect(
              await statusOf(observer, { ...fixture, ...sibling }),
            ).toEqual({ status: "applied", cleanupAttempts: 0 });
            // The earlier release queues a revision without its state row.
            await observer.execute(sql`
              UPDATE corpus_index_projection_intents
              SET status = 'cleanup_pending',
                  append_publish_barrier_at = append_committed_at + ${PUBLISH_DELAY},
                  cleanup_not_before = clock_timestamp(),
                  last_error = NULL, updated_at = clock_timestamp()
              WHERE id = ${sibling.revision} AND status = 'applied'
            `);
          }, [repair]);

          const outcome = await repair;
          if (outcome.isOk()) {
            panic("Expected the repair to be held");
          }
          expect(outcome.error.copies).toEqual([
            {
              generation: SIBLING,
              entityId: fixture.entityId,
              outcome: "held",
              risk: "restorable_cleanup",
            },
            {
              generation: GENERATION,
              entityId: fixture.entityId,
              outcome: "held",
              risk: "restorable_cleanup",
            },
          ]);
          // Nothing of the repair is left: the restored revision is queued
          // again, byte for byte, and no state or epoch moved.
          const after = await snapshotOf(observer, fixture);
          expect(after.states).toEqual(before.states);
          expect(after.canonical).toEqual(before.canonical);
          const queued = ({ id }: { id: string }) => id === fixture.revision;
          expect(after.revisions.find(queued)).toEqual(
            before.revisions.find(queued),
          );
        });
      });
    });
  });

  describe("a drifted copy a projection state serves (postgres)", () => {
    test("with no erasure recorded it keeps serving", async () => {
      await withDriftedDecision(async (writer, claimer, fixture) => {
        const kept = await claimDecision(claimer);
        expect(kept.leases).toEqual([]);
        expect(kept.restoredIntentIds).toHaveLength(1);
        expect(await statusOf(writer, fixture)).toEqual({
          status: "applied",
          cleanupAttempts: 0,
        });
        expect(await stateOf(writer, fixture)).toMatchObject({
          desiredAction: "upsert",
          appliedRevision: fixture.revision,
        });
      });
    });

    test("a withdrawal that reaches the state first is never passed over: the claim skips, then takes the copy", async () => {
      await withDriftedDecision(async (writer, claimer, fixture) => {
        const withdrawal = holdOpen(
          writer,
          async (tx) => await withdrawIn(tx, fixture),
        );
        await withdrawal.holds;
        await whileHeld(withdrawal, async () => {
          expect(await neverWaits(claimDecision(claimer))).toMatchObject({
            leases: [],
            restoredIntentIds: [],
            skippedLocked: 1,
          });
        });

        const after = await claimDecision(claimer);
        expect(after.restoredIntentIds).toEqual([]);
        expect(after.claimed.unserved).toBe(1);
      });
    });

    test("a withdrawal that waits for a keeping claim, and its undo, never re-serve the copy", async () => {
      await withDriftedDecision(async (writer, claimer, fixture, observer) => {
        const keeping = holdOpen(claimer, claimDecisionIn);
        const holder = await keeping.holds;
        // The withdrawal waits at the state the claim holds.
        const withdrawal = writer.transaction(
          async (tx) => await withdrawIn(tx, fixture),
        );
        const kept = await whileHeld(keeping, async () => {
          expect(await blockedBehind(observer, holder)).toBe(true);
        }, [withdrawal]);
        expect(kept.restoredIntentIds).toHaveLength(1);
        await withdrawal;
        expect(await stateOf(observer, fixture)).toMatchObject({
          desiredAction: "erase",
        });

        await restoreDocument(writer, fixture);
        expect(await stateOf(observer, fixture)).toEqual({
          desiredAction: "upsert",
          appliedAction: null,
          appliedRevision: null,
        });
        const after = await claimDecision(claimer);
        expect(after.restoredIntentIds).toEqual([]);
        expect(after.claimed.unserved).toBe(1);
      });
    });

    test("a withdrawal and its undo that kept the pointer are seen once they commit", async () => {
      await withDriftedDecision(async (writer, claimer, fixture) => {
        const undone = holdOpen(
          writer,
          async (tx) => await previousWithdrawAndUndoIn(tx, fixture),
        );
        await undone.holds;
        await whileHeld(undone, async () => {
          expect(await neverWaits(claimDecision(claimer))).toMatchObject({
            leases: [],
            restoredIntentIds: [],
            skippedLocked: 1,
          });
        });

        const after = await claimDecision(claimer);
        expect(after.restoredIntentIds).toEqual([]);
        expect(after.claimed.served_unproven).toBe(1);
        expect(await statusOf(claimer, fixture)).toEqual({
          status: "cleanup_started",
          cleanupAttempts: 1,
        });
      });
    });

    test("a withdrawal whose transaction began before the copy was reserved is recorded since the reservation", async () => {
      const proceed = Promise.withResolvers<undefined>();
      let withdrawal: Promise<void> | undefined;
      await withDriftedDecision(
        async (_writer, claimer, fixture) => {
          proceed.resolve(undefined);
          await (withdrawal ?? panic("The withdrawal did not begin"));
          const after = await claimDecision(claimer);
          expect(after.restoredIntentIds).toEqual([]);
          expect(after.claimed.served_unproven).toBe(1);
          expect(await statusOf(claimer, fixture)).toEqual({
            status: "cleanup_started",
            cleanupAttempts: 1,
          });
        },
        {
          // The withdrawal's transaction begins before the copy is reserved,
          // applied and queued, and reaches the state only after.
          beforeSeed: async (observer, fixture) => {
            const began = Promise.withResolvers<undefined>();
            const opened = observer.transaction(async (tx) => {
              await tx.execute(sql`SELECT 1`);
              began.resolve(undefined);
              await proceed.promise;
              await previousWithdrawAndUndoIn(tx, fixture);
            });
            withdrawal = opened;
            void opened.catch(began.reject);
            await began.promise;
            return async () => {
              proceed.resolve(undefined);
              await Promise.allSettled([opened]);
            };
          },
        },
      );
    });

    test("the guard reads the records after it holds the state: a restore that waited for a withdrawal is refused", async () => {
      await withDriftedDecision(async (writer, restorer, fixture, observer) => {
        const undone = holdOpen(
          writer,
          async (tx) => await previousWithdrawAndUndoIn(tx, fixture),
        );
        const holder = await undone.holds;
        // A writer that holds no state lock of its own.
        const restore = Result.tryPromise(
          async () =>
            await restorer.execute(sql`
              UPDATE corpus_index_projection_intents
              SET status = 'applied', cleanup_not_before = NULL,
                  lease_token = NULL, lease_expires_at = NULL
              WHERE id = ${fixture.revision}
            `),
        );
        await whileHeld(undone, async () => {
          expect(await blockedBehind(observer, holder)).toBe(true);
        }, [restore]);
        const refused = await restore;
        expect(refused.isErr() ? messagesOf(refused.error) : "").toContain(
          "only a queued copy its upsert state keeps serving can be restored",
        );
        expect((await statusOf(observer, fixture)).status).toBe(
          "cleanup_pending",
        );
      });
    });
  });
}
