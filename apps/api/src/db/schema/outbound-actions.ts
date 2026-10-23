import { sql } from "drizzle-orm";

import {
  OUTBOUND_ACTION_KINDS,
  OUTBOUND_ACTION_STATUSES,
  type OutboundActionKind,
  type OutboundActionStatus,
} from "@stll/api-contract/outbound-action";

import { chatThreads } from "./chat";
import {
  bytea,
  organization,
  outboundActionPolicies,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  timestamptz,
  user,
} from "./common";

const OUTBOUND_ACTION_KIND_SQL = OUTBOUND_ACTION_KINDS.map((kind) =>
  sql.raw(`'${kind}'`),
);
const OUTBOUND_ACTION_STATUS_SQL = OUTBOUND_ACTION_STATUSES.map((status) =>
  sql.raw(`'${status}'`),
);

/**
 * An action the assistant prepared to perform as the user outside stella,
 * waiting for the user's own confirmation. The preview is the exact content
 * the user is shown, encrypted with the per-organization content key; the
 * confirm must echo its hash, so an edited or replaced preview cannot be
 * confirmed by a click on an older one.
 */
export const outboundActions = p.pgTable(
  "outbound_actions",
  {
    id: pUuid<"outboundAction">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** The user the action acts as; only this user can confirm it. */
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Chat the assistant prepared the action in. */
    chatThreadId: safeUuid<"chatThread">("chat_thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    kind: p
      .text("kind", { enum: OUTBOUND_ACTION_KINDS })
      .notNull()
      .$type<OutboundActionKind>(),
    status: p
      .text("status", { enum: OUTBOUND_ACTION_STATUSES })
      .notNull()
      .$type<OutboundActionStatus>(),
    previewEncrypted: bytea("preview_encrypted").notNull(),
    previewIv: bytea("preview_iv").notNull(),
    /** SHA-256 hex of the canonical preview the user confirms. */
    previewHash: p.varchar("preview_hash", { length: 64 }).notNull(),
    /** Provider identifier of the delivered message, once sent. */
    providerMessageId: p.text("provider_message_id"),
    /** Stable failure code when the provider refused the action. */
    failureCode: p.varchar("failure_code", { length: 64 }),
    expiresAt: timestamptz("expires_at").notNull(),
    confirmedAt: timestamptz("confirmed_at"),
    completedAt: timestamptz("completed_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .index("outbound_actions_org_user_status_idx")
      .on(table.organizationId, table.userId, table.status),
    p.index("outbound_actions_chat_thread_idx").on(table.chatThreadId),
    p.check(
      "outbound_actions_kind_check",
      sql`${table.kind} IN (${sql.join(OUTBOUND_ACTION_KIND_SQL, sql`, `)})`,
    ),
    p.check(
      "outbound_actions_status_check",
      sql`${table.status} IN (${sql.join(OUTBOUND_ACTION_STATUS_SQL, sql`, `)})`,
    ),
    p.check(
      "outbound_actions_preview_hash_check",
      sql`${table.previewHash} ~ '^[0-9a-f]{64}$'`,
    ),
    ...outboundActionPolicies(),
  ],
);
