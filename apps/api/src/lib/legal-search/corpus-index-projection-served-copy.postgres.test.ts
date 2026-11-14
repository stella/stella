import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { settledWithin, waitFor } from "@stll/test-kit";

import {
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { repairAppliedCorpusProjectionDriftTx } from "@/api/lib/legal-search/corpus-index-projection-census-store";
import {
  claimCorpusProjectionCleanupTx,
  recoverExpiredCorpusProjectionIntentsTx,
} from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import { advanceCorpusProjectionDesiredStateTx } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
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

type Fixture = {
  sourceId: string;
  indexId: string;
  entityId: string;
  revision: string;
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
  const fingerprint = "a".repeat(64);
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
  await db.execute(sql`
    INSERT INTO corpus_index_projection_states (
      family, generation, entity_id, desired_action, desired_epoch,
      desired_fingerprint, desired_index_id, desired_at
    ) VALUES (
      'legislation', ${GENERATION}, ${entityId}, 'upsert', 1, ${fingerprint},
      ${indexId}, statement_timestamp()
    )
  `);
  await db.execute(sql`
    INSERT INTO corpus_index_projection_intents (
      id, family, generation, entity_id, epoch, fingerprint, index_id, status,
      lease_token, lease_expires_at
    ) VALUES (
      ${revision}, 'legislation', ${GENERATION}, ${entityId}, 1, ${fingerprint},
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
    WHERE generation = ${GENERATION} AND entity_id = ${entityId}
  `);
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

/**
 * A replacement the earlier release prepared: the desired value moves on,
 * then the served revision is queued for cleanup, pointer kept.
 */
const previousPrepare = async (db: GatedTestDb, fixture: Fixture) => {
  await writeCanonical(db, fixture, "b".repeat(64));
  const { revision } = fixture;
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
 * wait for it to end whatever `body` does: the suite's cleanup deletes rows
 * the held transaction locks, so a failed assertion would otherwise hang the
 * test instead of reporting. Returns what the held transaction returned.
 */
const whileHeld = async <T>(
  held: Held<T>,
  body: () => Promise<void>,
): Promise<T> => {
  try {
    await body();
  } finally {
    held.release();
    // When `body` failed, its error is the one to report.
    await Promise.allSettled([held.done]);
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
 * Removes the suite's rows. Nonterminal projection history is deletable only
 * while the generation is retiring under the rebuild fence.
 */
const cleanUp = async (db: GatedTestDb, fixture: Fixture) => {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1937007986, 1)`);
    await tx.execute(sql`
      UPDATE corpus_index_generations SET status = 'retiring'
      WHERE family = 'legislation' AND generation = ${GENERATION}
    `);
    await tx.execute(sql`
      DELETE FROM corpus_index_projection_states
      WHERE family = 'legislation' AND generation = ${GENERATION}
    `);
    await tx.execute(sql`
      DELETE FROM corpus_index_projection_intents
      WHERE family = 'legislation' AND generation = ${GENERATION}
    `);
  });
  await db.execute(sql`
    UPDATE corpus_index_generations SET status = 'retired'
    WHERE family = 'legislation' AND generation = ${GENERATION}
  `);
  await db.execute(sql`
    DELETE FROM corpus_index_generations
    WHERE family = 'legislation' AND generation = ${GENERATION}
  `);
  await db.execute(sql`
    DELETE FROM legislation_documents WHERE id = ${fixture.entityId}
  `);
  await db.execute(sql`
    DELETE FROM legislation_sources WHERE id = ${fixture.sourceId}
  `);
};

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
        });
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
        });
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
        // The desired value moved after the revision was queued: no proof
        // that the copy is the one to serve, so it is claimed, not restored.
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
  });
}
