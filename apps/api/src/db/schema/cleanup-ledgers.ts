import type { SQL } from "drizzle-orm";

import {
  DESTRUCTIVE_EFFECT_CHUNK_STATUSES,
  p,
  safeUuid,
  sql,
  timestamptz,
} from "./common";
import type { AnyPgColumn, DestructiveEffectChunkStatus } from "./common";

// Durable storage-cleanup ledgers share one shape per kind: a cleanup request
// that a deleting transaction records, and the bounded effect chunks a root
// worker claims and erases. Each table keeps its own name, id brand, and
// policies; the columns and constraints below are identical across tables
// apart from the constraint-name prefix.

/** Retry bookkeeping of a deletion cleanup request, after its `status`. */
export const deletionCleanupRetryColumns = () => ({
  attemptCount: p.integer("attempt_count").notNull().default(0),
  errorMessage: p.text("error_message"),
  nextAttemptAt: timestamptz("next_attempt_at"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  completedAt: timestamptz("completed_at"),
});

type DeletionCleanupConstraintsOptions = {
  table: {
    id: AnyPgColumn;
    status: AnyPgColumn;
    attemptCount: AnyPgColumn;
    nextAttemptAt: AnyPgColumn;
    createdAt: AnyPgColumn;
    updatedAt: AnyPgColumn;
  };
  prefix: string;
  statusSqlValues: SQL[];
};

/** Scheduling indexes and value checks of a deletion cleanup request table. */
export const deletionCleanupConstraints = ({
  table,
  prefix,
  statusSqlValues,
}: DeletionCleanupConstraintsOptions) => [
  p
    .index(`${prefix}_pending_schedule_idx`)
    .on(table.createdAt, table.id)
    .where(sql`${table.status} = 'pending'`),
  p
    .index(`${prefix}_failed_schedule_idx`)
    .on(table.nextAttemptAt, table.id)
    .where(sql`${table.status} = 'failed'`),
  p
    .index(`${prefix}_processing_lease_idx`)
    .on(table.updatedAt, table.id)
    .where(sql`${table.status} = 'processing'`),
  p.check(
    `${prefix}_status_values_check`,
    sql`${table.status} IN (${sql.join(statusSqlValues, sql`, `)})`,
  ),
  p.check(
    `${prefix}_attempt_count_nonnegative_check`,
    sql`${table.attemptCount} >= 0`,
  ),
];

const DESTRUCTIVE_EFFECT_CHUNK_STATUS_SQL_VALUES =
  DESTRUCTIVE_EFFECT_CHUNK_STATUSES.map((status) => sql.raw(`'${status}'`));

/** Every column of an effect chunk after its `id` and `requestId`. */
export const destructiveEffectChunkColumns = () => ({
  chunkIndex: p.integer("chunk_index").notNull(),
  effectType: p
    .text("effect_type", { enum: ["s3_delete"] })
    .notNull()
    .default("s3_delete"),
  payloadHash: p.varchar("payload_hash", { length: 64 }).notNull(),
  s3Keys: p.text("s3_keys").array().notNull(),
  status: p
    .text("status", { enum: DESTRUCTIVE_EFFECT_CHUNK_STATUSES })
    .$type<DestructiveEffectChunkStatus>()
    .notNull()
    .default("pending"),
  attemptCount: p.integer("attempt_count").notNull().default(0),
  leaseToken: safeUuid<"effectLease">("lease_token"),
  leaseExpiresAt: timestamptz("lease_expires_at"),
  nextAttemptAt: timestamptz("next_attempt_at"),
  errorMessage: p.text("error_message"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  completedAt: timestamptz("completed_at"),
});

type DestructiveEffectChunkConstraintsOptions = {
  table: {
    requestId: AnyPgColumn;
    chunkIndex: AnyPgColumn;
    effectType: AnyPgColumn;
    payloadHash: AnyPgColumn;
    s3Keys: AnyPgColumn;
    status: AnyPgColumn;
    attemptCount: AnyPgColumn;
    leaseToken: AnyPgColumn;
    leaseExpiresAt: AnyPgColumn;
    nextAttemptAt: AnyPgColumn;
  };
  /** The cleanup request id the chunks cascade from. */
  requestIdColumn: AnyPgColumn;
  prefix: string;
};

/** Claim indexes and state checks of an effect chunk table. */
export const destructiveEffectChunkConstraints = ({
  table,
  requestIdColumn,
  prefix,
}: DestructiveEffectChunkConstraintsOptions) => [
  p
    .foreignKey({
      columns: [table.requestId],
      foreignColumns: [requestIdColumn],
      name: `${prefix}_request_fk`,
    })
    .onDelete("cascade"),
  p
    .uniqueIndex(`${prefix}_request_index_uidx`)
    .on(table.requestId, table.chunkIndex),
  p
    .index(`${prefix}_pending_claim_idx`)
    .on(table.requestId, table.chunkIndex)
    .where(sql`${table.status} = 'pending'`),
  p
    .index(`${prefix}_failed_claim_idx`)
    .on(table.nextAttemptAt, table.requestId, table.chunkIndex)
    .where(sql`${table.status} = 'failed'`),
  p
    .index(`${prefix}_lease_expiry_idx`)
    .on(table.leaseExpiresAt, table.requestId, table.chunkIndex)
    .where(sql`${table.status} = 'processing'`),
  p.check(
    `${prefix}_status_check`,
    sql`${table.status} IN (${sql.join(DESTRUCTIVE_EFFECT_CHUNK_STATUS_SQL_VALUES, sql`, `)})`,
  ),
  p.check(
    `${prefix}_effect_type_check`,
    sql`${table.effectType} = 's3_delete'`,
  ),
  p.check(
    `${prefix}_attempt_nonnegative_check`,
    sql`${table.attemptCount} >= 0`,
  ),
  p.check(`${prefix}_index_nonnegative_check`, sql`${table.chunkIndex} >= 0`),
  p.check(
    `${prefix}_payload_hash_check`,
    sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
  ),
  p.check(
    `${prefix}_payload_bound_check`,
    sql`(${table.status} = 'completed' AND cardinality(${table.s3Keys}) = 0) OR (${table.status} <> 'completed' AND cardinality(${table.s3Keys}) BETWEEN 1 AND 50)`,
  ),
  p.check(
    `${prefix}_lease_state_check`,
    sql`(${table.status} = 'processing') = (${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
  ),
  p.check(
    `${prefix}_retry_state_check`,
    sql`(${table.status} = 'failed') = (${table.nextAttemptAt} IS NOT NULL)`,
  ),
];
