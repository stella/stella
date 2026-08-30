import {
  NOTIFICATION_ENTITY_TYPES,
  NOTIFICATION_KINDS,
} from "@stll/api-contract/notifications";
import type { NotificationMetadataValue } from "@stll/api-contract/notifications";

import {
  jsonb,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  sql,
  timestamptz,
  user,
  userPolicies,
} from "./common";

const NOTIFICATION_KIND_SQL_VALUES = NOTIFICATION_KINDS.map((kind) =>
  sql.raw(`'${kind}'`),
);
const NOTIFICATION_ENTITY_TYPE_SQL_VALUES = NOTIFICATION_ENTITY_TYPES.map(
  (entityType) => sql.raw(`'${entityType}'`),
);

/**
 * A per-user awareness pointer: "you were mentioned", "your export finished",
 * "your flow run needs approval", "announcement". Read/unread is its only
 * state — `readAt IS NULL` means unread, so there is no boolean to disagree
 * with the timestamp.
 *
 * `organizationId` records the organization the event happened in, not a
 * second owner: the list endpoint filters to the caller's ACTIVE organization
 * so a user who belongs to several firms does not see one firm's activity
 * while working in another. RLS still pins every row to its own user.
 *
 * `idempotencyKey` makes producers replay-safe: a retried worker job, a BullMQ
 * redelivery, or two workers racing the same run insert the same key and the
 * unique index turns the duplicate into a no-op.
 */
export const notifications = p.pgTable(
  "notifications",
  {
    id: pUuid<"notification">().primaryKey(),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: p.text({ enum: NOTIFICATION_KINDS }).notNull(),
    /** Exactly the ICU parameters this kind's message renders. */
    metadata: jsonb().$type<NotificationMetadataValue>().notNull(),
    entityType: p.text("entity_type", { enum: NOTIFICATION_ENTITY_TYPES }),
    entityId: p.text("entity_id"),
    idempotencyKey: p.text("idempotency_key").notNull(),
    /** NULL means unread. There is no `is_read` mirror to drift from this. */
    readAt: timestamptz("read_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .uniqueIndex("notifications_user_idempotency_uidx")
      .on(table.userId, table.idempotencyKey),
    p
      .index("notifications_user_org_created_idx")
      .on(table.userId, table.organizationId, table.createdAt.desc(), table.id),
    // Partial: the unread badge counts a tiny slice of a long history, and the
    // index stays proportional to what is actually unread rather than to the
    // whole table.
    p
      .index("notifications_user_org_unread_idx")
      .on(table.userId, table.organizationId)
      .where(sql`${table.readAt} IS NULL`),
    p.check(
      "notifications_kind_check",
      sql`${table.kind} in (${sql.join(NOTIFICATION_KIND_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "notifications_entity_type_check",
      sql`${table.entityType} is null or ${table.entityType} in (${sql.join(NOTIFICATION_ENTITY_TYPE_SQL_VALUES, sql`, `)})`,
    ),
    // A pointer is either whole or absent; a half-set pointer is a producer
    // bug that would reach the client as an unresolvable link.
    p.check(
      "notifications_entity_pointer_check",
      sql`(${table.entityType} IS NULL) = (${table.entityId} IS NULL)`,
    ),
    ...userPolicies(),
  ],
);
