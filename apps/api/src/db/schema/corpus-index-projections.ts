import {
  CORPUS_FAMILIES,
  CORPUS_INDEX_GENERATION_MAX_LENGTH,
} from "@/api/lib/legal-search/corpus-generation-contract";
import {
  CORPUS_INDEX_DESIRED_ACTIONS,
  CORPUS_INDEX_DOCUMENT_COUNT_REQUIRED_INTENT_STATUSES,
  CORPUS_INDEX_INTENT_STATUSES,
  CORPUS_INDEX_PROJECTION_FAILURE_KINDS,
  CORPUS_INDEX_PROJECTION_WORK_STATUSES,
} from "@/api/lib/legal-search/corpus-index-projection-contract";
import {
  corpusIndexProjectionIntentIsOutstanding,
  corpusIndexProjectionIsBlocked,
  corpusIndexProjectionNeedsWork,
  corpusIndexProjectionProducesAppend,
} from "@/api/lib/legal-search/corpus-index-projection-sql";

import {
  globalCaseLawPolicies,
  p,
  pUuid,
  type SafeId,
  sql,
  timestamptz,
} from "./common";
import { corpusIndexGenerations } from "./corpus-index-generations";

const sqlValues = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql.raw(","),
  );

/**
 * One immutable Quickwit append attempt. Its UUID is written into every
 * passage as `projection_revision`, so cleanup can delete this attempt without
 * touching a later append whose content fingerprint happens to be identical.
 */
export const corpusIndexProjectionIntents = p.pgTable(
  "corpus_index_projection_intents",
  {
    id: pUuid<"corpusIndexProjectionIntent">().primaryKey(),
    family: p.text({ enum: CORPUS_FAMILIES }).notNull(),
    generation: p
      .varchar({ length: CORPUS_INDEX_GENERATION_MAX_LENGTH })
      .notNull(),
    entityId: p.uuid("entity_id").notNull(),
    epoch: p.bigint({ mode: "bigint" }).notNull(),
    fingerprint: p.varchar({ length: 64 }).notNull(),
    indexId: p.varchar("index_id", { length: 64 }).notNull(),
    status: p.text({ enum: CORPUS_INDEX_INTENT_STATUSES }).notNull(),
    leaseToken: p.uuid("lease_token"),
    leaseExpiresAt: timestamptz("lease_expires_at"),
    appendStartedAt: timestamptz("append_started_at"),
    appendCommittedAt: timestamptz("append_committed_at"),
    expectedDocumentCount: p.integer("expected_document_count"),
    appliedAt: timestamptz("applied_at"),
    appendPublishBarrierAt: timestamptz("append_publish_barrier_at"),
    cleanupNotBefore: timestamptz("cleanup_not_before"),
    cleanupStartedAt: timestamptz("cleanup_started_at"),
    deleteOpstamp: p.bigint("delete_opstamp", { mode: "bigint" }),
    settledAt: timestamptz("settled_at"),
    cancelledAt: timestamptz("cancelled_at"),
    cleanupAttempts: p.integer("cleanup_attempts").default(0).notNull(),
    lastError: p.varchar("last_error", { length: 2048 }),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p
      .foreignKey({
        name: "corpus_index_projection_intents_generation_fk",
        columns: [t.family, t.generation],
        foreignColumns: [
          corpusIndexGenerations.family,
          corpusIndexGenerations.generation,
        ],
      })
      .onDelete("restrict"),
    p
      .uniqueIndex("corpus_index_projection_intents_append_epoch_uidx")
      .on(t.family, t.generation, t.entityId, t.epoch)
      .where(corpusIndexProjectionProducesAppend(t.status)),
    p
      .uniqueIndex("corpus_index_projection_intents_identity_uidx")
      .on(
        t.id,
        t.family,
        t.generation,
        t.entityId,
        t.epoch,
        t.fingerprint,
        t.indexId,
      ),
    p
      .index("corpus_index_projection_intents_work_idx")
      .on(
        t.family,
        t.generation,
        t.status,
        t.cleanupNotBefore,
        t.leaseExpiresAt,
        t.createdAt,
      ),
    p
      .index("corpus_index_projection_intents_entity_idx")
      .on(t.family, t.generation, t.entityId, t.createdAt),
    // The append and erasure queues ask whether an entity still owes the index
    // an exact action. Keyed on the identity they probe and partial on the
    // answer, so the probe reads the outstanding revisions alone instead of
    // walking a revision history that only ever grows.
    p
      .index("corpus_index_projection_intents_outstanding_idx")
      .on(t.family, t.generation, t.entityId, t.epoch)
      .where(corpusIndexProjectionIntentIsOutstanding(t.status)),
    p
      .index("corpus_index_projection_intents_expired_lease_idx")
      .on(t.family, t.generation, t.status, t.leaseExpiresAt)
      .where(
        sql`${t.status} IN ('reserved', 'append_started', 'cleanup_started')`,
      ),
    p
      .index("corpus_index_projection_intents_cleanup_claim_idx")
      .on(
        t.family,
        t.generation,
        t.indexId,
        t.status,
        t.cleanupNotBefore,
        t.createdAt,
      )
      .where(sql`${t.status} = 'cleanup_pending'`),
    p
      .index("corpus_index_projection_intents_settlement_next_idx")
      .on(
        t.family,
        t.generation,
        t.indexId,
        t.status,
        t.cleanupStartedAt,
        t.createdAt,
      )
      .where(sql`${t.status} = 'cleanup_committed'`),
    p
      .index("corpus_index_projection_intents_settlement_batch_idx")
      .on(
        t.family,
        t.generation,
        t.indexId,
        t.status,
        t.deleteOpstamp,
        t.createdAt,
      )
      .where(sql`${t.status} = 'cleanup_committed'`),
    p
      .index("corpus_index_projection_intents_settled_census_idx")
      .on(t.family, t.generation, t.indexId, t.id)
      .where(sql`${t.status} = 'settled'`),
    p.check(
      "corpus_index_projection_intents_family_values",
      sql`${t.family} IN (${sqlValues(CORPUS_FAMILIES)})`,
    ),
    p.check(
      "corpus_index_projection_intents_status_values",
      sql`${t.status} IN (${sqlValues(CORPUS_INDEX_INTENT_STATUSES)})`,
    ),
    p.check(
      "corpus_index_projection_intents_epoch_positive",
      sql`${t.epoch} > 0`,
    ),
    p.check(
      "corpus_index_projection_intents_fingerprint_shape",
      sql`${t.fingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    p.check(
      "corpus_index_projection_intents_index_id_shape",
      sql`${t.indexId} ~ '^[a-z0-9_]+$'`,
    ),
    p.check(
      "corpus_index_projection_intents_lease_shape",
      sql`(${t.leaseToken} IS NULL) = (${t.leaseExpiresAt} IS NULL)`,
    ),
    p.check(
      "corpus_index_projection_intents_cleanup_attempts_nonnegative",
      sql`${t.cleanupAttempts} >= 0`,
    ),
    p.check(
      "corpus_index_projection_intents_delete_opstamp_nonnegative",
      sql`${t.deleteOpstamp} IS NULL OR ${t.deleteOpstamp} >= 0`,
    ),
    p.check(
      "corpus_index_projection_intents_expected_document_count_shape",
      sql`CASE
        WHEN ${t.status} IN (${sqlValues(CORPUS_INDEX_DOCUMENT_COUNT_REQUIRED_INTENT_STATUSES)}) THEN
          ${t.expectedDocumentCount} IS NOT NULL
          AND ${t.expectedDocumentCount} > 0
        WHEN ${t.expectedDocumentCount} IS NOT NULL THEN
          ${t.expectedDocumentCount} > 0
        ELSE true
      END`,
    ),
    p.check(
      "corpus_index_projection_intents_status_shape",
      sql`CASE ${t.status}
        WHEN 'reserved' THEN
          ${t.leaseToken} IS NOT NULL
          AND ${t.appendStartedAt} IS NULL
          AND ${t.appendCommittedAt} IS NULL
          AND ${t.appliedAt} IS NULL
          AND ${t.appendPublishBarrierAt} IS NULL
          AND ${t.cleanupNotBefore} IS NULL
          AND ${t.cleanupStartedAt} IS NULL
          AND ${t.deleteOpstamp} IS NULL
          AND ${t.settledAt} IS NULL
          AND ${t.cancelledAt} IS NULL
        WHEN 'append_started' THEN
          ${t.leaseToken} IS NOT NULL
          AND ${t.appendStartedAt} IS NOT NULL
          AND ${t.appendCommittedAt} IS NULL
          AND ${t.appliedAt} IS NULL
          AND ${t.appendPublishBarrierAt} IS NULL
          AND ${t.cleanupNotBefore} IS NULL
          AND ${t.cleanupStartedAt} IS NULL
          AND ${t.deleteOpstamp} IS NULL
          AND ${t.settledAt} IS NULL
          AND ${t.cancelledAt} IS NULL
        WHEN 'append_committed' THEN
          ${t.leaseToken} IS NOT NULL
          AND ${t.appendStartedAt} IS NOT NULL
          AND ${t.appendCommittedAt} IS NOT NULL
          AND ${t.appliedAt} IS NULL
          AND ${t.appendPublishBarrierAt} IS NULL
          AND ${t.cleanupNotBefore} IS NULL
          AND ${t.cleanupStartedAt} IS NULL
          AND ${t.deleteOpstamp} IS NULL
          AND ${t.settledAt} IS NULL
          AND ${t.cancelledAt} IS NULL
        WHEN 'applied' THEN
          ${t.leaseToken} IS NULL
          AND ${t.appendStartedAt} IS NOT NULL
          AND ${t.appendCommittedAt} IS NOT NULL
          AND ${t.appliedAt} IS NOT NULL
          AND ${t.appendPublishBarrierAt} IS NULL
          AND ${t.cleanupNotBefore} IS NULL
          AND ${t.cleanupStartedAt} IS NULL
          AND ${t.deleteOpstamp} IS NULL
          AND ${t.settledAt} IS NULL
          AND ${t.cancelledAt} IS NULL
        WHEN 'cleanup_pending' THEN
          ${t.appendStartedAt} IS NOT NULL
          AND ${t.appendPublishBarrierAt} IS NOT NULL
          AND ${t.cleanupNotBefore} IS NOT NULL
          AND ${t.cleanupStartedAt} IS NULL
          AND ${t.deleteOpstamp} IS NULL
          AND ${t.settledAt} IS NULL
          AND ${t.cancelledAt} IS NULL
        WHEN 'cleanup_started' THEN
          ${t.appendStartedAt} IS NOT NULL
          AND ${t.appendPublishBarrierAt} IS NOT NULL
          AND ${t.cleanupNotBefore} IS NOT NULL
          AND ${t.cleanupStartedAt} IS NOT NULL
          AND ${t.deleteOpstamp} IS NULL
          AND ${t.settledAt} IS NULL
          AND ${t.cancelledAt} IS NULL
        WHEN 'cleanup_committed' THEN
          ${t.appendStartedAt} IS NOT NULL
          AND ${t.appendPublishBarrierAt} IS NOT NULL
          AND ${t.cleanupNotBefore} IS NOT NULL
          AND ${t.cleanupStartedAt} IS NOT NULL
          AND ${t.deleteOpstamp} IS NOT NULL
          AND ${t.settledAt} IS NULL
          AND ${t.cancelledAt} IS NULL
        WHEN 'settled' THEN
          ${t.leaseToken} IS NULL
          AND ${t.appendStartedAt} IS NOT NULL
          AND ${t.appendPublishBarrierAt} IS NOT NULL
          AND ${t.cleanupNotBefore} IS NOT NULL
          AND ${t.cleanupStartedAt} IS NOT NULL
          AND ${t.deleteOpstamp} IS NOT NULL
          AND ${t.settledAt} IS NOT NULL
          AND ${t.cancelledAt} IS NULL
        WHEN 'cancelled' THEN
          ${t.leaseToken} IS NULL
          AND ${t.appendStartedAt} IS NULL
          AND ${t.appendCommittedAt} IS NULL
          AND ${t.appliedAt} IS NULL
          AND ${t.appendPublishBarrierAt} IS NULL
          AND ${t.cleanupNotBefore} IS NULL
          AND ${t.cleanupStartedAt} IS NULL
          AND ${t.deleteOpstamp} IS NULL
          AND ${t.settledAt} IS NULL
          AND ${t.cancelledAt} IS NOT NULL
        ELSE false
      END`,
    ),
    p.check(
      "corpus_index_projection_intents_cleanup_order",
      sql`${t.cleanupNotBefore} IS NULL OR (
        ${t.cleanupNotBefore}::timestamptz >= ${t.appendPublishBarrierAt}::timestamptz
        AND (${t.cleanupStartedAt} IS NULL OR ${t.cleanupStartedAt}::timestamptz >= ${t.cleanupNotBefore}::timestamptz)
        AND (${t.settledAt} IS NULL OR ${t.settledAt}::timestamptz >= ${t.cleanupStartedAt}::timestamptz)
      )`,
    ),
    p.check(
      "corpus_index_projection_intents_append_order",
      sql`(${t.appendCommittedAt} IS NULL OR ${t.appendCommittedAt}::timestamptz >= ${t.appendStartedAt}::timestamptz)
        AND (${t.appliedAt} IS NULL OR ${t.appliedAt}::timestamptz >= ${t.appendCommittedAt}::timestamptz)
        AND (${t.appendPublishBarrierAt} IS NULL OR ${t.appendPublishBarrierAt}::timestamptz >= ${t.appendStartedAt}::timestamptz)`,
    ),
    ...globalCaseLawPolicies(),
  ],
);

/** PostgreSQL-authoritative desired and applied state for one generation. */
export const corpusIndexProjectionStates = p.pgTable(
  "corpus_index_projection_states",
  {
    family: p.text({ enum: CORPUS_FAMILIES }).notNull(),
    generation: p
      .varchar({ length: CORPUS_INDEX_GENERATION_MAX_LENGTH })
      .notNull(),
    entityId: p.uuid("entity_id").notNull(),
    desiredAction: p
      .text("desired_action", { enum: CORPUS_INDEX_DESIRED_ACTIONS })
      .notNull(),
    desiredEpoch: p.bigint("desired_epoch", { mode: "bigint" }).notNull(),
    desiredFingerprint: p.varchar("desired_fingerprint", { length: 64 }),
    desiredIndexId: p.varchar("desired_index_id", { length: 64 }),
    workStatus: p
      .text("work_status", { enum: CORPUS_INDEX_PROJECTION_WORK_STATUSES })
      .default("eligible")
      .notNull(),
    retryNotBefore: timestamptz("retry_not_before"),
    failureAttempts: p.integer("failure_attempts").default(0).notNull(),
    lastFailureKind: p.text("last_failure_kind", {
      enum: CORPUS_INDEX_PROJECTION_FAILURE_KINDS,
    }),
    lastFailureMessage: p.varchar("last_failure_message", { length: 2048 }),
    appliedAction: p.text("applied_action", {
      enum: CORPUS_INDEX_DESIRED_ACTIONS,
    }),
    appliedEpoch: p.bigint("applied_epoch", { mode: "bigint" }),
    // Exact successfully applied revision. Cleanup keeps this immutable history
    // pointer until a later append or erasure replaces it.
    appliedRevision: p
      .uuid("applied_revision")
      .$type<SafeId<"corpusIndexProjectionIntent">>(),
    appliedFingerprint: p.varchar("applied_fingerprint", { length: 64 }),
    appliedIndexId: p.varchar("applied_index_id", { length: 64 }),
    appliedAt: timestamptz("applied_at"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p.primaryKey({
      name: "corpus_index_projection_states_pkey",
      columns: [t.family, t.generation, t.entityId],
    }),
    p
      .foreignKey({
        name: "corpus_index_projection_states_generation_fk",
        columns: [t.family, t.generation],
        foreignColumns: [
          corpusIndexGenerations.family,
          corpusIndexGenerations.generation,
        ],
      })
      .onDelete("restrict"),
    p
      .foreignKey({
        name: "corpus_index_projection_states_applied_revision_fk",
        columns: [
          t.appliedRevision,
          t.family,
          t.generation,
          t.entityId,
          t.appliedEpoch,
          t.appliedFingerprint,
          t.appliedIndexId,
        ],
        foreignColumns: [
          corpusIndexProjectionIntents.id,
          corpusIndexProjectionIntents.family,
          corpusIndexProjectionIntents.generation,
          corpusIndexProjectionIntents.entityId,
          corpusIndexProjectionIntents.epoch,
          corpusIndexProjectionIntents.fingerprint,
          corpusIndexProjectionIntents.indexId,
        ],
      })
      .onDelete("restrict"),
    p
      .uniqueIndex("corpus_index_projection_states_applied_revision_uidx")
      .on(t.appliedRevision)
      .where(sql`${t.appliedRevision} IS NOT NULL`),
    p
      .index("corpus_index_projection_states_pending_idx")
      .on(
        t.family,
        t.generation,
        sql`coalesce(${t.retryNotBefore}, ${t.updatedAt})`,
        t.entityId,
      )
      .where(corpusIndexProjectionNeedsWork(t)),
    p
      .index("corpus_index_projection_states_pending_route_idx")
      .on(
        t.family,
        t.generation,
        t.desiredIndexId,
        sql`coalesce(${t.retryNotBefore}, ${t.updatedAt})`,
        t.entityId,
      )
      .where(corpusIndexProjectionNeedsWork(t)),
    p
      .index("corpus_index_projection_states_replacement_route_idx")
      .on(t.family, t.generation, t.desiredIndexId, t.updatedAt, t.entityId)
      .where(
        sql`${t.desiredAction} = 'upsert'
          AND ${t.appliedAction} = 'upsert'
          AND ${t.appliedRevision} IS NOT NULL
          AND ${t.appliedIndexId} IS NOT NULL
          AND ${t.desiredEpoch} > ${t.appliedEpoch}`,
      ),
    p
      .index("corpus_index_projection_states_blocked_idx")
      .on(t.family, t.generation, t.entityId)
      .where(corpusIndexProjectionIsBlocked(t.workStatus)),
    p
      .index("corpus_index_projection_states_applied_census_idx")
      .on(t.family, t.generation, t.appliedIndexId, t.entityId)
      .where(
        sql`${t.appliedAction} = 'upsert' AND ${t.appliedRevision} IS NOT NULL`,
      ),
    p.check(
      "corpus_index_projection_states_family_values",
      sql`${t.family} IN (${sqlValues(CORPUS_FAMILIES)})`,
    ),
    p.check(
      "corpus_index_projection_states_desired_action_values",
      sql`${t.desiredAction} IN (${sqlValues(CORPUS_INDEX_DESIRED_ACTIONS)})`,
    ),
    p.check(
      "corpus_index_projection_states_applied_action_values",
      sql`${t.appliedAction} IS NULL OR ${t.appliedAction} IN (${sqlValues(CORPUS_INDEX_DESIRED_ACTIONS)})`,
    ),
    p.check(
      "corpus_index_projection_states_work_status_values",
      sql`${t.workStatus} IN (${sqlValues(CORPUS_INDEX_PROJECTION_WORK_STATUSES)})`,
    ),
    p.check(
      "corpus_index_projection_states_failure_kind_values",
      sql`${t.lastFailureKind} IS NULL OR ${t.lastFailureKind} IN (${sqlValues(CORPUS_INDEX_PROJECTION_FAILURE_KINDS)})`,
    ),
    p.check(
      "corpus_index_projection_states_failure_attempts_nonnegative",
      sql`${t.failureAttempts} >= 0`,
    ),
    p.check(
      "corpus_index_projection_states_work_shape",
      sql`CASE ${t.workStatus}
        WHEN 'eligible' THEN
          ${t.retryNotBefore} IS NULL
          AND ${t.failureAttempts} = 0
          AND ${t.lastFailureKind} IS NULL
          AND ${t.lastFailureMessage} IS NULL
        WHEN 'retry_scheduled' THEN
          ${t.retryNotBefore} IS NOT NULL
          AND ${t.failureAttempts} > 0
          AND ${t.lastFailureKind} IS NOT NULL
          AND ${t.lastFailureMessage} IS NOT NULL
        WHEN 'repair_scheduled' THEN
          ${t.retryNotBefore} IS NULL
          AND ${t.failureAttempts} = 0
          AND ${t.lastFailureKind} IS NULL
          AND ${t.lastFailureMessage} IS NULL
        WHEN 'blocked' THEN
          ${t.retryNotBefore} IS NULL
          AND ${t.failureAttempts} > 0
          AND ${t.lastFailureKind} IS NOT NULL
          AND ${t.lastFailureMessage} IS NOT NULL
        ELSE false
      END`,
    ),
    p.check(
      "corpus_index_projection_states_epoch_order",
      sql`${t.desiredEpoch} > 0 AND (
        ${t.appliedEpoch} IS NULL
        OR (${t.appliedEpoch} > 0 AND ${t.appliedEpoch} <= ${t.desiredEpoch})
      )`,
    ),
    p.check(
      "corpus_index_projection_states_desired_shape",
      sql`CASE ${t.desiredAction}
        WHEN 'upsert' THEN
          ${t.desiredFingerprint} IS NOT NULL
          AND ${t.desiredFingerprint} ~ '^[0-9a-f]{64}$'
          AND ${t.desiredIndexId} IS NOT NULL
          AND ${t.desiredIndexId} ~ '^[a-z0-9_]+$'
        WHEN 'erase' THEN
          ${t.desiredFingerprint} IS NULL
          AND ${t.desiredIndexId} IS NULL
        ELSE false
      END`,
    ),
    p.check(
      "corpus_index_projection_states_applied_shape",
      sql`CASE
        WHEN ${t.appliedAction} IS NULL THEN
          ${t.appliedEpoch} IS NULL
          AND ${t.appliedRevision} IS NULL
          AND ${t.appliedFingerprint} IS NULL
          AND ${t.appliedIndexId} IS NULL
          AND ${t.appliedAt} IS NULL
        WHEN ${t.appliedAction} = 'upsert' THEN
          ${t.appliedEpoch} IS NOT NULL
          AND ${t.appliedRevision} IS NOT NULL
          AND ${t.appliedFingerprint} IS NOT NULL
          AND ${t.appliedFingerprint} ~ '^[0-9a-f]{64}$'
          AND ${t.appliedIndexId} IS NOT NULL
          AND ${t.appliedIndexId} ~ '^[a-z0-9_]+$'
          AND ${t.appliedAt} IS NOT NULL
        WHEN ${t.appliedAction} = 'erase' THEN
          ${t.appliedEpoch} IS NOT NULL
          AND ${t.appliedRevision} IS NULL
          AND ${t.appliedFingerprint} IS NULL
          AND ${t.appliedIndexId} IS NULL
          AND ${t.appliedAt} IS NOT NULL
        ELSE false
      END`,
    ),
    ...globalCaseLawPolicies(),
  ],
);
