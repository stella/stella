import { inArray, sql } from "drizzle-orm";
import {
  check,
  index,
  pgPolicy,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import {
  oauthClient,
  oauthConsent,
  organization,
  user,
} from "@/api/db/auth-schema";
import { timestamptz } from "@/api/db/columns";
import { denyStellaAccessPolicies } from "@/api/db/rls";

export const MCP_WEB_HANDOFF_KINDS = ["text", "click"] as const;
export const MCP_WEB_HANDOFF_MAX_PATHS = 50;

export const mcpWebHandoff = pgTable(
  "mcp_web_handoff",
  {
    id: text("id").primaryKey(),
    // SHA-256 digest of the single-use handoff code; never the code itself.
    codeHash: text("code_hash").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    oauthClientId: text("oauth_client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    consentId: text("consent_id")
      .notNull()
      .references(() => oauthConsent.id, { onDelete: "cascade" }),
    allowedPaths: text("allowed_paths").array().notNull(),
    kind: text("kind", { enum: MCP_WEB_HANDOFF_KINDS }).notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    consumedAt: timestamptz("consumed_at"),
    confirmationShownAt: timestamptz("confirmation_shown_at"),
    // Audit reference retained independently of browser session deletion.
    consumedSessionId: text("consumed_session_id"),
    createdIpHash: text("created_ip_hash"),
    consumedIpHash: text("consumed_ip_hash"),
    uaHash: text("ua_hash"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("mcp_web_handoff_codeHash_idx").on(table.codeHash),
    index("mcp_web_handoff_organizationId_consentId_idx").on(
      table.organizationId,
      table.consentId,
    ),
    index("mcp_web_handoff_consentId_idx").on(table.consentId),
    index("mcp_web_handoff_userId_idx").on(table.userId),
    index("mcp_web_handoff_oauthClientId_idx").on(table.oauthClientId),
    index("mcp_web_handoff_expiresAt_id_idx").on(table.expiresAt, table.id),
    check(
      "mcp_web_handoff_kind_check",
      inArray(table.kind, MCP_WEB_HANDOFF_KINDS),
    ),
    check(
      "mcp_web_handoff_allowedPaths_check",
      sql`cardinality(${table.allowedPaths}) BETWEEN 1 AND ${MCP_WEB_HANDOFF_MAX_PATHS}`,
    ),
    check(
      "mcp_web_handoff_codeHash_check",
      sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`,
    ),
    pgPolicy("mcp_web_handoff_owner_access", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.mcp_web_handoff'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.mcp_web_handoff'::regclass)`,
    }),
    ...denyStellaAccessPolicies(),
  ],
);
