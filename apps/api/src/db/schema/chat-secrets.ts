import { sql } from "drizzle-orm";

import { chatSecretPolicies } from "@/api/db/rls";

import { chatThreads } from "./chat";
import {
  bytea,
  organization,
  p,
  safeOrganizationId,
  safeUuid,
  timestamptz,
  user,
} from "./common";
import { mcpConnectors } from "./mcp";

export const CHAT_SECRET_DECISIONS = ["provided", "declined"] as const;

export const chatSecrets = p.pgTable.withRLS(
  "chat_secrets",
  {
    id: p.uuid().defaultRandom().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: safeUuid<"chatThread">("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    toolCallId: p.text("tool_call_id").notNull(),
    connectorId: safeUuid<"mcpConnector">("connector_id")
      .notNull()
      .references(() => mcpConnectors.id, { onDelete: "cascade" }),
    targetUrl: p.text("target_url").notNull(),
    decision: p.text({ enum: CHAT_SECRET_DECISIONS }).notNull(),
    ciphertext: bytea("ciphertext"),
    iv: bytea("iv"),
    expiresAt: timestamptz("expires_at").notNull(),
    remainingUses: p.integer("remaining_uses").notNull().default(8),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .uniqueIndex("chat_secrets_request_uidx")
      .on(table.organizationId, table.userId, table.threadId, table.toolCallId),
    p.index("chat_secrets_thread_idx").on(table.threadId),
    p.index("chat_secrets_connector_idx").on(table.connectorId),
    p.index("chat_secrets_expiry_idx").on(table.expiresAt),
    p.index("chat_secrets_user_idx").on(table.userId),
    p.check(
      "chat_secrets_decision_check",
      sql`(${table.decision} = 'provided' AND ${table.ciphertext} IS NOT NULL AND ${table.iv} IS NOT NULL) OR (${table.decision} = 'provided' AND ${table.remainingUses} = 0 AND ${table.ciphertext} IS NULL AND ${table.iv} IS NULL) OR (${table.decision} = 'declined' AND ${table.ciphertext} IS NULL AND ${table.iv} IS NULL)`,
    ),
    p.check(
      "chat_secrets_remaining_uses_check",
      sql`${table.remainingUses} BETWEEN 0 AND 8`,
    ),
    ...chatSecretPolicies(),
  ],
);
