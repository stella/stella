import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql, TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import { lockPendingCorpusProjectionCleanups } from "@/api/lib/db/aggregate-lock";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  claimCorpusProjectionCleanupTx,
  type CorpusProjectionCleanupClaim,
} from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import { advanceCorpusProjectionDesiredStateTx } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { corpusIndexAppendPublishDelayMs } from "@/api/lib/legal-search/corpus-index-projection-engine";
import { advanceCorpusProjectionErasuresTx } from "@/api/lib/legal-search/corpus-index-projection-erasure-store";
import { corpusIndexProjectionRevisionIsRestorable } from "@/api/lib/legal-search/corpus-index-projection-sql";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * Rows an earlier release writes, and what this release does with them. The
 * earlier release prepares replacements delete-first, claims cleanup without
 * a guard, and keeps the pointer through erasure and drift repair; its
 * statements are replayed here in the shapes it issues them, against the
 * guards before and after this release's migration.
 */

/** The earlier release's publish fence: acceptance plus the generation's delay. */
const PUBLISH_DELAY = sql.raw(
  `(${corpusIndexAppendPublishDelayMs(CORPUS_INDEX_MANIFESTS.legislation_v2)} * interval '1 millisecond')`,
);
const GENERATION = "legislation_v2";
const INDEX_ID = "legislation_v2_cze";
const SERVED_COPY_MIGRATION =
  "20261115080000_corpus_projection_served_copy_guard";
const DRIZZLE_DIR = new URL("../../../drizzle/", import.meta.url);
const SOURCE_ID = "0198e331-e578-7000-8000-000000000af1";
const FINGERPRINTS = ["a", "b", "c", "d", "e"].map((digit) => digit.repeat(64));

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let nextId = 1;

const uuid = () => {
  const value = nextId;
  nextId += 1;
  return `0198e331-e578-7000-8000-${value.toString(16).padStart(12, "0")}`;
};

const fingerprint = (index: number) =>
  FINGERPRINTS.at(index) ?? panic("No such test fingerprint");

/** The projection guards and triggers, up to (and maybe with) this release's. */
const installProjectionDdl = async (
  withServedCopyGuard: boolean,
): Promise<void> => {
  const migrations = [
    ...new Bun.Glob("*corpus*projection*/migration.sql").scanSync(
      Bun.fileURLToPath(DRIZZLE_DIR),
    ),
  ]
    .filter((migration) => !migration.includes("projection_revision"))
    .filter(
      (migration) =>
        withServedCopyGuard || !migration.startsWith(SERVED_COPY_MIGRATION),
    )
    .toSorted();
  for (const migration of migrations) {
    const text = await Bun.file(new URL(migration, DRIZZLE_DIR)).text();
    for (const statement of text.split("--> statement-breakpoint")) {
      const ddl = statement.trim();
      if (
        /(?:^|\n)\s*CREATE (?:OR REPLACE )?FUNCTION\b/u.test(ddl) ||
        /(?:^|\n)\s*CREATE TRIGGER\b/u.test(ddl)
      ) {
        // db-await-in-loop: DDL applies in migration order
        await db.execute(sql.raw(ddl));
      }
    }
  }
};

const installServedCopyGuard = async (): Promise<void> => {
  const text = await Bun.file(
    new URL(`${SERVED_COPY_MIGRATION}/migration.sql`, DRIZZLE_DIR),
  ).text();
  for (const statement of text.split("--> statement-breakpoint")) {
    const ddl = statement.trim();
    if (/(?:^|\n)\s*CREATE (?:OR REPLACE )?FUNCTION\b/u.test(ddl)) {
      // db-await-in-loop: DDL applies in migration order
      await db.execute(sql.raw(ddl));
    }
  }
};

/**
 * One statement, on an instant of its own: PGlite's clock moves in
 * milliseconds, and the restore proof compares two statements' instants.
 */
const run = async (statement: ReturnType<typeof sql>) => {
  await db.execute(sql`SELECT pg_sleep(0.002)`);
  await db.execute(statement);
};

/** A legislation document projected once: its state names one applied revision. */
const servedEntity = async () => {
  const entityId = uuid();
  const revision = uuid();
  await run(sql`
    INSERT INTO legislation_documents (
      id, source_id, eli, title, country, language, document_type, status,
      content_hash, projection_epoch
    ) VALUES (
      ${entityId}, ${SOURCE_ID}, ${`eli/cz/test/${entityId}`}, 'Act', 'CZE',
      'cs', 'act', 'current', ${fingerprint(4)}, 1
    )
  `);
  await run(sql`
    INSERT INTO corpus_index_projection_states (
      family, generation, entity_id, desired_action, desired_epoch,
      desired_fingerprint, desired_index_id, desired_at
    ) VALUES (
      'legislation', ${GENERATION}, ${entityId}, 'upsert', 1,
      ${fingerprint(0)}, ${INDEX_ID}, statement_timestamp()
    )
  `);
  // Reserve, start, then the earlier release's leased commit and apply,
  // long enough ago that its publish fence has passed.
  await run(sql`
    INSERT INTO corpus_index_projection_intents (
      id, family, generation, entity_id, epoch, fingerprint, index_id, status,
      lease_token, lease_expires_at
    ) VALUES (
      ${revision}, 'legislation', ${GENERATION}, ${entityId}, 1,
      ${fingerprint(0)}, ${INDEX_ID}, 'reserved', ${uuid()},
      clock_timestamp() + interval '5 minutes'
    )
  `);
  await run(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'append_started',
        append_started_at = clock_timestamp() - interval '2 hours'
    WHERE id = ${revision}
  `);
  await run(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'append_committed',
        append_committed_at = clock_timestamp() - interval '2 hours',
        expected_document_count = 1
    WHERE id = ${revision}
  `);
  await run(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'applied', lease_token = NULL, lease_expires_at = NULL,
        applied_at = clock_timestamp() - interval '2 hours'
    WHERE id = ${revision}
  `);
  await run(sql`
    UPDATE corpus_index_projection_states
    SET applied_action = 'upsert', applied_epoch = 1,
        applied_revision = ${revision}, applied_fingerprint = ${fingerprint(0)},
        applied_index_id = ${INDEX_ID}, applied_at = clock_timestamp(),
        work_status = 'eligible'
    WHERE entity_id = ${entityId}
  `);
  return { entityId, revision };
};

/** A canonical change and the desired state the writers derive from it. */
const changeDesired = async (
  entityId: string,
  epoch: number,
  next: { action: "upsert"; fingerprint: string } | { action: "erase" },
) => {
  await run(sql`
    UPDATE legislation_documents SET projection_epoch = ${epoch}
    WHERE id = ${entityId}
  `);
  const fingerprintValue = next.action === "upsert" ? next.fingerprint : null;
  const indexValue = next.action === "upsert" ? INDEX_ID : null;
  await run(sql`
    UPDATE corpus_index_projection_states
    SET desired_action = ${next.action}, desired_epoch = ${epoch},
        desired_fingerprint = ${fingerprintValue},
        desired_index_id = ${indexValue},
        desired_at = statement_timestamp(), work_status = 'eligible',
        retry_not_before = NULL, failure_attempts = 0,
        last_failure_kind = NULL, last_failure_message = NULL,
        updated_at = statement_timestamp()
    WHERE entity_id = ${entityId}
  `);
};

/** The earlier release's replacement preparation of one served revision. */
const previousPrepare = async (entityId: string, revision: string) => {
  await run(sql`
    UPDATE corpus_index_projection_states SET updated_at = clock_timestamp()
    WHERE entity_id = ${entityId}
  `);
  await run(sql`
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

/** The earlier release's unguarded cleanup claim of one revision. */
const previousClaim = async (revision: string) => {
  await run(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'cleanup_started', lease_token = ${uuid()},
        lease_expires_at = clock_timestamp() + interval '1 minute',
        cleanup_started_at = clock_timestamp(),
        cleanup_attempts = cleanup_attempts + 1,
        updated_at = clock_timestamp()
    WHERE id = ${revision} AND status = 'cleanup_pending'
  `);
};

const previousRecordDelete = async (revision: string, opstamp: number) => {
  await run(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'cleanup_committed', lease_token = NULL,
        lease_expires_at = NULL, delete_opstamp = ${opstamp},
        delete_task_created_at = clock_timestamp(), last_error = NULL,
        updated_at = clock_timestamp()
    WHERE id = ${revision} AND status = 'cleanup_started'
  `);
};

const previousSweepCleanup = async (revision: string) => {
  await run(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'cleanup_pending', lease_token = NULL,
        lease_expires_at = NULL, cleanup_started_at = NULL,
        last_error = 'projection cleanup lease expired with unknown outcome',
        updated_at = clock_timestamp()
    WHERE id = ${revision} AND status = 'cleanup_started'
  `);
};

/** The earlier release's erasure claim: fence, keep the pointer until settled. */
const previousErasureFence = async (revision: string) => {
  await run(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'cleanup_pending', lease_token = NULL, lease_expires_at = NULL,
        append_publish_barrier_at = append_committed_at + ${PUBLISH_DELAY},
        cleanup_not_before = GREATEST(
          clock_timestamp(),
          append_committed_at + ${PUBLISH_DELAY}
        ),
        last_error = 'projection revision scheduled by erasure',
        updated_at = clock_timestamp()
    WHERE id = ${revision} AND status IN ('append_committed', 'applied')
  `);
};

/** The earlier release's drift repair: schedule, then retire, pointer kept. */
const previousRepair = async (entityId: string, revision: string) => {
  await run(sql`
    UPDATE corpus_index_projection_states
    SET work_status = 'repair_scheduled', retry_not_before = NULL,
        failure_attempts = 0, last_failure_kind = NULL,
        last_failure_message = NULL, updated_at = clock_timestamp()
    WHERE entity_id = ${entityId} AND applied_revision = ${revision}
  `);
  await run(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'cleanup_pending',
        append_publish_barrier_at = append_committed_at + ${PUBLISH_DELAY},
        cleanup_not_before = GREATEST(
          clock_timestamp(),
          append_committed_at + ${PUBLISH_DELAY}
        ),
        last_error = 'applied census observed engine drift',
        updated_at = clock_timestamp()
    WHERE id = ${revision} AND status = 'applied'
  `);
};

/**
 * Every transition of the earlier release's lifecycle, in its statement
 * shapes: prepare, unguarded claim, delete receipt, reissue, settle, reopen,
 * the expired-lease sweep, erasure with the pointer kept until settlement,
 * drift repair with the pointer kept, and an abandoned append.
 */
const previousReleaseLifecycle = async () => {
  const replaced = await servedEntity();
  await changeDesired(replaced.entityId, 2, {
    action: "upsert",
    fingerprint: fingerprint(1),
  });
  await previousPrepare(replaced.entityId, replaced.revision);
  await previousClaim(replaced.revision);
  await previousSweepCleanup(replaced.revision);
  await previousClaim(replaced.revision);
  await previousRecordDelete(replaced.revision, 1);
  await run(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'cleanup_pending', lease_token = NULL,
        lease_expires_at = NULL, cleanup_not_before = clock_timestamp(),
        cleanup_started_at = NULL, delete_opstamp = NULL,
        delete_task_created_at = NULL, delete_reissues = delete_reissues + 1,
        last_error = 'delete re-issued', updated_at = clock_timestamp()
    WHERE id = ${replaced.revision} AND status = 'cleanup_committed'
  `);
  await previousClaim(replaced.revision);
  await previousRecordDelete(replaced.revision, 2);
  await run(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'settled', settled_at = clock_timestamp(),
        updated_at = clock_timestamp()
    WHERE id = ${replaced.revision} AND status = 'cleanup_committed'
  `);
  await run(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'cleanup_pending', cleanup_not_before = clock_timestamp(),
        cleanup_started_at = NULL, delete_opstamp = NULL,
        delete_task_created_at = NULL, settled_at = NULL,
        last_error = 'census found the revision after settlement',
        updated_at = clock_timestamp()
    WHERE id = ${replaced.revision} AND status = 'settled'
  `);

  const erased = await servedEntity();
  await changeDesired(erased.entityId, 2, { action: "erase" });
  await previousErasureFence(erased.revision);
  await previousClaim(erased.revision);
  await previousRecordDelete(erased.revision, 3);
  await run(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'settled', settled_at = clock_timestamp()
    WHERE id = ${erased.revision}
  `);
  await run(sql`
    UPDATE corpus_index_projection_states
    SET applied_action = 'erase', applied_epoch = desired_epoch,
        applied_revision = NULL, applied_fingerprint = NULL,
        applied_index_id = NULL, applied_at = clock_timestamp()
    WHERE entity_id = ${erased.entityId}
  `);

  const repaired = await servedEntity();
  await previousRepair(repaired.entityId, repaired.revision);

  const abandoned = await servedEntity();
  await changeDesired(abandoned.entityId, 2, {
    action: "upsert",
    fingerprint: fingerprint(1),
  });
  const attempt = uuid();
  await run(sql`
    INSERT INTO corpus_index_projection_intents (
      id, family, generation, entity_id, epoch, fingerprint, index_id, status,
      lease_token, lease_expires_at
    ) VALUES (
      ${attempt}, 'legislation', ${GENERATION}, ${abandoned.entityId}, 2,
      ${fingerprint(1)}, ${INDEX_ID}, 'reserved', ${uuid()},
      clock_timestamp() + interval '5 minutes'
    )
  `);
  await run(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'append_started', append_started_at = clock_timestamp()
    WHERE id = ${attempt}
  `);
  await run(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'cleanup_pending', lease_token = NULL,
        lease_expires_at = NULL,
        append_publish_barrier_at = append_started_at + interval '20 minutes',
        cleanup_not_before = append_started_at + interval '20 minutes',
        last_error = 'projection append lease expired with unknown outcome'
    WHERE id = ${attempt}
  `);
  await run(sql`
    UPDATE corpus_index_projection_states
    SET work_status = 'retry_scheduled',
        retry_not_before = clock_timestamp() + interval '5 seconds',
        failure_attempts = 1, last_failure_kind = 'append_unknown',
        last_failure_message = 'projection append lease expired with unknown outcome'
    WHERE entity_id = ${abandoned.entityId}
  `);
};

const seedGeneration = async () => {
  await run(sql`
    INSERT INTO corpus_index_generations (
      family, generation, cluster, manifest_digest, status
    ) VALUES (
      'legislation', ${GENERATION}, 'q09',
      ${corpusIndexManifestDigest(CORPUS_INDEX_MANIFESTS.legislation_v2)},
      'building'
    )
  `);
  await run(sql`
    INSERT INTO legislation_sources (id, adapter_key, name)
    VALUES (${SOURCE_ID}, 'projection-legacy-test', 'Projection legacy test')
  `);
};

beforeEach(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await seedGeneration();
});

afterEach(async () => {
  await client.close();
});

const claim = async (): Promise<CorpusProjectionCleanupClaim> =>
  await db.transaction(
    async (tx) =>
      await claimCorpusProjectionCleanupTx(asTestRaw<Transaction>(tx), {
        family: "legislation",
        generation: GENERATION,
        indexId: INDEX_ID,
        limit: 16,
        leaseMs: 60_000,
      }),
  );

const intentOf = async (revision: string) =>
  (
    await db
      .select({
        status: corpusIndexProjectionIntents.status,
        cleanupAttempts: corpusIndexProjectionIntents.cleanupAttempts,
        cleanupNotBefore: corpusIndexProjectionIntents.cleanupNotBefore,
        lastError: corpusIndexProjectionIntents.lastError,
      })
      .from(corpusIndexProjectionIntents)
      .where(
        eq(
          corpusIndexProjectionIntents.id,
          toSafeId<"corpusIndexProjectionIntent">(revision),
        ),
      )
  ).at(0) ?? panic("No such revision");

const stateOf = async (entityId: string) =>
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

describe("the migration and the previous release", () => {
  test("every write the previous release makes passes the guards before and after the migration", async () => {
    await installProjectionDdl(false);
    await previousReleaseLifecycle();
    await installServedCopyGuard();
    await previousReleaseLifecycle();
    const statuses = await db.execute<{ status: string; count: number }>(sql`
      SELECT status, count(*)::int AS count
      FROM corpus_index_projection_intents
      GROUP BY status ORDER BY status
    `);
    // Both lifecycles ran to the same end.
    expect(statuses.rows.every(({ count }) => count % 2 === 0)).toBe(true);
  });
});

describe("cleanup of revisions the previous release left served", () => {
  beforeEach(async () => {
    await installProjectionDdl(true);
  });

  test("a prepared revision no delete reached is restored, not claimed", async () => {
    const { entityId, revision } = await servedEntity();
    await changeDesired(entityId, 2, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    await previousPrepare(entityId, revision);

    const result = await claim();
    expect(result.leases).toEqual([]);
    expect(result.restoredIntentIds).toEqual([
      toSafeId<"corpusIndexProjectionIntent">(revision),
    ]);
    expect(await intentOf(revision)).toEqual({
      status: "applied",
      cleanupAttempts: 0,
      cleanupNotBefore: null,
      lastError: null,
    });
    expect(await stateOf(entityId)).toMatchObject({
      desiredAction: "upsert",
      appliedAction: "upsert",
      appliedRevision: revision,
    });
  });

  test("a prepared revision whose desired value changed again is claimed as unproven", async () => {
    const { entityId, revision } = await servedEntity();
    await changeDesired(entityId, 2, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    await previousPrepare(entityId, revision);
    await changeDesired(entityId, 3, { action: "erase" });
    await changeDesired(entityId, 4, {
      action: "upsert",
      fingerprint: fingerprint(2),
    });

    const result = await claim();
    expect(result.restoredIntentIds).toEqual([]);
    expect(result.claimed).toEqual({
      unserved: 0,
      served_after_delete: 0,
      served_unproven: 1,
    });
    expect(await intentOf(revision)).toMatchObject({
      status: "cleanup_started",
      cleanupAttempts: 1,
    });
  });

  test("a served revision a delete may have reached is claimed again, never held", async () => {
    const { entityId, revision } = await servedEntity();
    await changeDesired(entityId, 2, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    await previousPrepare(entityId, revision);
    await previousClaim(revision);
    await previousSweepCleanup(revision);

    const result = await claim();
    expect(result.claimed).toEqual({
      unserved: 0,
      served_after_delete: 1,
      served_unproven: 0,
    });
    expect(await intentOf(revision)).toMatchObject({
      status: "cleanup_started",
      cleanupAttempts: 2,
    });
  });

  test("an erasure the previous release undid is claimed, never restored", async () => {
    const { entityId, revision } = await servedEntity();
    await changeDesired(entityId, 2, { action: "erase" });
    await previousErasureFence(revision);
    await changeDesired(entityId, 3, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });

    const result = await claim();
    expect(result.restoredIntentIds).toEqual([]);
    expect(result.claimed.served_unproven).toBe(1);
  });

  test("a drift repair the previous release scheduled is claimed, never restored", async () => {
    const { entityId, revision } = await servedEntity();
    await previousRepair(entityId, revision);

    const result = await claim();
    expect(result.restoredIntentIds).toEqual([]);
    expect(result.claimed.served_unproven).toBe(1);
  });

  test("this release's erasure un-names a revision the previous release kept named", async () => {
    const { entityId, revision } = await servedEntity();
    await changeDesired(entityId, 2, { action: "erase" });
    await previousErasureFence(revision);
    await db.transaction(
      async (tx) =>
        await advanceCorpusProjectionErasuresTx(asTestRaw<Transaction>(tx), {
          family: "legislation",
          generation: GENERATION,
          limit: 16,
        }),
    );
    expect(await stateOf(entityId)).toEqual({
      desiredAction: "erase",
      appliedAction: null,
      appliedRevision: null,
    });
    expect((await claim()).claimed.unserved).toBe(1);
  });

  test("this release's undo of an erasure un-names a revision the previous release kept named", async () => {
    const { entityId, revision } = await servedEntity();
    await changeDesired(entityId, 2, { action: "erase" });
    await previousErasureFence(revision);
    await run(sql`
      UPDATE legislation_documents SET content_hash = ${fingerprint(3)}
      WHERE id = ${entityId}
    `);
    await db.transaction(
      async (tx) =>
        await advanceCorpusProjectionDesiredStateTx(
          asTestRaw<Transaction>(tx),
          {
            family: "legislation",
            entityId: toSafeId<"legislationDocument">(entityId),
          },
        ),
    );
    expect(await stateOf(entityId)).toEqual({
      desiredAction: "upsert",
      appliedAction: null,
      appliedRevision: null,
    });
    expect((await claim()).claimed.unserved).toBe(1);
  });

  test("the walk advances past every row it reads", async () => {
    const restored: SafeId<"corpusIndexProjectionIntent">[] = [];
    for (let index = 0; index < 4; index += 1) {
      // db-await-in-loop: rows are seeded in queue order
      const { entityId, revision } = await servedEntity();
      await changeDesired(entityId, 2, {
        action: "upsert",
        fingerprint: fingerprint(1),
      });
      await previousPrepare(entityId, revision);
      restored.push(toSafeId<"corpusIndexProjectionIntent">(revision));
    }
    const first = await claim();
    expect(first.restoredIntentIds.toSorted()).toEqual(restored.toSorted());
    // Nothing the first turn read is left at the head of the queue.
    expect(await claim()).toEqual({
      leases: [],
      claimed: { unserved: 0, served_after_delete: 0, served_unproven: 0 },
      restoredIntentIds: [],
      skippedLocked: 0,
    });
  });

  test("corpus-projection.restore-guard-matches-predicate", async () => {
    await assertProperty(
      "corpus-projection.restore-guard-matches-predicate",
      fc.asyncProperty(
        fc.record({
          claimedBefore: fc.boolean(),
          lastError: fc.boolean(),
          changedAfterQueueing: fc.constantFrom(
            "unchanged" as const,
            "upsert" as const,
            "erase" as const,
          ),
        }),
        async ({ claimedBefore, lastError, changedAfterQueueing }) => {
          const { entityId, revision } = await servedEntity();
          await changeDesired(entityId, 2, {
            action: "upsert",
            fingerprint: fingerprint(1),
          });
          await previousPrepare(entityId, revision);
          if (claimedBefore) {
            await previousClaim(revision);
            await previousSweepCleanup(revision);
            await run(sql`
              UPDATE corpus_index_projection_intents SET last_error = NULL
              WHERE id = ${revision}
            `);
          }
          if (lastError) {
            await run(sql`
              UPDATE corpus_index_projection_intents
              SET last_error = 'projection revision scheduled by erasure'
              WHERE id = ${revision}
            `);
          }
          if (changedAfterQueueing !== "unchanged") {
            await changeDesired(
              entityId,
              3,
              changedAfterQueueing === "upsert"
                ? { action: "upsert", fingerprint: fingerprint(2) }
                : { action: "erase" },
            );
          }
          const intents = corpusIndexProjectionIntents;
          const states = corpusIndexProjectionStates;
          const predicate = (
            await db
              .select({
                restorable: corpusIndexProjectionRevisionIsRestorable({
                  revisionId: intents.id,
                  appliedRevision: states.appliedRevision,
                  desiredAction: states.desiredAction,
                  appliedAction: states.appliedAction,
                  revisionEpoch: intents.epoch,
                  cleanupAttempts: intents.cleanupAttempts,
                  revisionAppliedAt: intents.appliedAt,
                  lastError: intents.lastError,
                  revisionUpdatedAt: intents.updatedAt,
                  appliedEpoch: states.appliedEpoch,
                  desiredAt: states.desiredAt,
                }).mapWith(Boolean),
              })
              .from(intents)
              .innerJoin(states, eq(states.appliedRevision, intents.id))
              .where(
                eq(
                  intents.id,
                  toSafeId<"corpusIndexProjectionIntent">(revision),
                ),
              )
          ).at(0)?.restorable;
          const accepted = await Result.tryPromise(
            async () =>
              await db.transaction(async (tx) => {
                await tx.execute(sql`
                  UPDATE corpus_index_projection_intents
                  SET status = 'applied', cleanup_not_before = NULL,
                      lease_token = NULL, lease_expires_at = NULL
                  WHERE id = ${revision}
                `);
                tx.rollback();
              }),
          );
          // A rollback after the update means the guard admitted it.
          const admitted =
            accepted.isErr() &&
            accepted.error.cause instanceof TransactionRollbackError;
          expect({ admitted }).toEqual({ admitted: predicate === true });
          expect(predicate).toBe(
            !claimedBefore &&
              !lastError &&
              changedAfterQueueing === "unchanged",
          );
        },
      ),
      { numRuns: 24 },
    );
  });
});

describe("the cleanup claim's row lock", () => {
  beforeEach(async () => {
    await installProjectionDdl(true);
  });

  const lockDue = async (revision: string) =>
    await db.transaction(
      async (tx) =>
        await lockPendingCorpusProjectionCleanups(asTestRaw<Transaction>(tx), [
          toSafeId<"corpusIndexProjectionIntent">(revision),
        ]),
    );

  test("re-checks the fence and lease the unlocked page read", async () => {
    // The page saw the row due; by the lock it was claimed and requeued with
    // a later fence, or holds an unexpired lease. Neither may be claimed yet.
    const { entityId, revision } = await servedEntity();
    await changeDesired(entityId, 2, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    await previousPrepare(entityId, revision);
    expect(await lockDue(revision)).toHaveLength(1);

    await run(sql`
      UPDATE corpus_index_projection_intents
      SET cleanup_not_before = clock_timestamp() + interval '1 hour'
      WHERE id = ${revision}
    `);
    expect(await lockDue(revision)).toEqual([]);

    await run(sql`
      UPDATE corpus_index_projection_intents
      SET cleanup_not_before = clock_timestamp() - interval '1 second',
          lease_token = ${uuid()},
          lease_expires_at = clock_timestamp() + interval '1 hour'
      WHERE id = ${revision}
    `);
    expect(await lockDue(revision)).toEqual([]);

    await run(sql`
      UPDATE corpus_index_projection_intents
      SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE id = ${revision}
    `);
    expect(await lockDue(revision)).toHaveLength(1);
  });
});
