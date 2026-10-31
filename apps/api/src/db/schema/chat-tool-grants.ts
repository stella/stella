import { sql } from "drizzle-orm";

import {
  CHAT_TOOL_GRANT_SCOPES,
  type ChatToolGrantScope,
} from "@stll/api-contract/chat-tool-grants";

import { chatThreads } from "./chat";
import {
  chatToolGrantPolicies,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  timestamptz,
  user,
} from "./common";
import { mcpConnectors } from "./mcp";

const CHAT_TOOL_GRANT_SCOPE_SQL = CHAT_TOOL_GRANT_SCOPES.map((scope) =>
  sql.raw(`'${scope}'`),
);

/**
 * A user's standing approval for an approval-gated chat tool. The API skips
 * the approval prompt only for calls a row here covers, and refuses to store
 * a row for a tool whose grant policy is not grantable. A grant covers either
 * one built-in or skill tool by name, or every tool of one installed external
 * MCP connector; deleting the connector deletes its grants.
 */
export const chatToolGrants = p.pgTable(
  "chat_tool_grants",
  {
    id: pUuid<"chatToolGrant">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scope: p
      .text("scope", { enum: CHAT_TOOL_GRANT_SCOPES })
      .notNull()
      .$type<ChatToolGrantScope>(),
    /** Conversation a `conversation` grant applies to; null for `always`. */
    chatThreadId: safeUuid<"chatThread">("chat_thread_id").references(
      () => chatThreads.id,
      { onDelete: "cascade" },
    ),
    /** Built-in or skill tool the grant covers; null for a connector grant. */
    toolName: p.varchar("tool_name", { length: 128 }),
    /** External MCP connector whose tools the grant covers. */
    mcpConnectorId: safeUuid<"mcpConnector">("mcp_connector_id").references(
      () => mcpConnectors.id,
      { onDelete: "cascade" },
    ),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("chat_tool_grants_org_user_scope_idx")
      .on(table.organizationId, table.userId, table.scope),
    p.index("chat_tool_grants_chat_thread_idx").on(table.chatThreadId),
    p.index("chat_tool_grants_mcp_connector_idx").on(table.mcpConnectorId),
    // One grant per subject and scope; storing it again is a no-op.
    p
      .unique("chat_tool_grants_subject_key")
      .on(
        table.organizationId,
        table.userId,
        table.scope,
        table.chatThreadId,
        table.toolName,
        table.mcpConnectorId,
      )
      .nullsNotDistinct(),
    p.check(
      "chat_tool_grants_scope_check",
      sql`${table.scope} IN (${sql.join(CHAT_TOOL_GRANT_SCOPE_SQL, sql`, `)})`,
    ),
    p.check(
      "chat_tool_grants_scope_thread_check",
      sql`(${table.scope} = 'conversation') = (${table.chatThreadId} IS NOT NULL)`,
    ),
    p.check(
      "chat_tool_grants_one_subject_check",
      sql`(${table.toolName} IS NULL) <> (${table.mcpConnectorId} IS NULL)`,
    ),
    ...chatToolGrantPolicies(),
  ],
);
