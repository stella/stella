import { panic } from "better-result";
import { eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
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
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

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
export const GENERATION = "legislation_v2";
const INDEX_ID = "legislation_v2_cze";
const SERVED_COPY_MIGRATION =
  "20261115120000_corpus_projection_served_copy_guard";
const DRIZZLE_DIR = new URL("../../../drizzle/", import.meta.url);
const SOURCE_ID = "0198e331-e578-7000-8000-000000000af1";
const FINGERPRINTS = ["a", "b", "c", "d", "e"].map((digit) => digit.repeat(64));

/**
 * The legacy projection fixture over one test database, which the caller
 * opens before each test (`database` reads the current one) and seeds with
 * `seedGeneration`.
 */
export const corpusProjectionLegacyFixture = (
  database: () => ReturnType<typeof drizzle>,
) => {
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
          await database().execute(sql.raw(ddl));
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
        await database().execute(sql.raw(ddl));
      }
    }
  };

  /**
   * One statement, on an instant of its own: PGlite's clock moves in
   * milliseconds, and the restore proof compares two statements' instants.
   */
  const run = async (statement: ReturnType<typeof sql>) => {
    await database().execute(sql`SELECT pg_sleep(0.002)`);
    await database().execute(statement);
  };

  /**
   * A legislation document projected once: its state names one applied revision.
   * `desiredAtRecorded: false` writes the state the way writers did before
   * `desired_at` existed.
   */
  const servedEntity = async ({ desiredAtRecorded = true } = {}) => {
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
        ${fingerprint(0)}, ${INDEX_ID},
        ${desiredAtRecorded ? sql`statement_timestamp()` : sql`NULL`}
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

  /**
   * A canonical change and the desired state the earlier release's writer
   * derives from it. `desiredAtRecorded: false` is the same write before
   * `desired_at` existed.
   */
  const changeDesired = async (
    entityId: string,
    epoch: number,
    next: { action: "upsert"; fingerprint: string } | { action: "erase" },
    { desiredAtRecorded = true } = {},
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
          desired_at = ${desiredAtRecorded ? sql`statement_timestamp()` : sql`desired_at`},
          work_status = 'eligible',
          retry_not_before = NULL, failure_attempts = 0,
          last_failure_kind = NULL, last_failure_message = NULL,
          updated_at = statement_timestamp()
      WHERE entity_id = ${entityId}
    `);
  };

  /** A canonical content change written through this release's desired writer. */
  const thisReleaseChanges = async (entityId: string, contentHash: string) => {
    await run(sql`
      UPDATE legislation_documents SET content_hash = ${contentHash}
      WHERE id = ${entityId}
    `);
    await database().transaction(
      async (tx) =>
        await advanceCorpusProjectionDesiredStateTx(
          asTestRaw<Transaction>(tx),
          {
            family: "legislation",
            entityId: toSafeId<"legislationDocument">(entityId),
          },
        ),
    );
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

  const claim = async (): Promise<CorpusProjectionCleanupClaim> =>
    await database().transaction(
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
      await database()
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
      await database()
        .select({
          desiredAction: corpusIndexProjectionStates.desiredAction,
          appliedAction: corpusIndexProjectionStates.appliedAction,
          appliedRevision: corpusIndexProjectionStates.appliedRevision,
        })
        .from(corpusIndexProjectionStates)
        .where(eq(corpusIndexProjectionStates.entityId, entityId))
    ).at(0) ?? panic("No such state");

  return {
    uuid,
    fingerprint,
    installProjectionDdl,
    installServedCopyGuard,
    run,
    servedEntity,
    changeDesired,
    thisReleaseChanges,
    previousPrepare,
    previousClaim,
    previousRecordDelete,
    previousSweepCleanup,
    previousErasureFence,
    previousRepair,
    previousReleaseLifecycle,
    seedGeneration,
    claim,
    intentOf,
    stateOf,
  };
};
