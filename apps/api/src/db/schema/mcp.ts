import { sql } from "drizzle-orm";

import { MCP_CONNECTION_STATUSES, MCP_CONNECTOR_AUTH_TYPES } from "./chat";
import type {
  McpConnectionStatus,
  McpConnectorAuthType,
  McpOAuthRegistrationResponse,
} from "./chat";
import {
  bytea,
  isNotNull,
  isNull,
  jsonb,
  mcpConnectorAuthorizationReviewPolicies,
  mcpConnectorPolicies,
  mcpOAuthClientPolicies,
  mcpOAuthStatePolicies,
  mcpUserConnectionPolicies,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  user,
  timestamptz,
} from "./common";

export const mcpConnectors = p.pgTable(
  "mcp_connectors",
  {
    id: pUuid<"mcpConnector">().primaryKey(),
    slug: p.varchar({ length: 80 }).notNull(),
    organizationId: safeOrganizationId("organization_id").references(
      () => organization.id,
      { onDelete: "cascade" },
    ),
    displayName: p.varchar("display_name", { length: 160 }).notNull(),
    description: p.text().notNull(),
    url: p.text().notNull(),
    authType: p
      .text("auth_type", { enum: MCP_CONNECTOR_AUTH_TYPES })
      .notNull()
      .$type<McpConnectorAuthType>(),
    isCurated: p.boolean("is_curated").notNull().default(false),
    oauthRequestedScopes: p.text("oauth_requested_scopes").array(),
    allowedTools: p.text("allowed_tools").array(),
    documentationUrl: p.text("documentation_url"),
    tokenHelpUrl: p.text("token_help_url"),
    iconUrl: p.text("icon_url"),
    // OAuth authorization-server issuer, captured at create time for
    // oauth2 connectors. Surfaced as the connector's vendor. Server-level
    // and identical for every member, so it lives on the shared row.
    oauthIssuer: p.text("oauth_issuer"),
    oauthConfirmedEndpointOrigins: jsonb(
      "oauth_confirmed_endpoint_origins",
    ).$type<string[]>(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("mcp_connectors_curated_slug_uidx")
      .on(table.slug)
      .where(isNull(table.organizationId)),
    p
      .uniqueIndex("mcp_connectors_custom_org_slug_uidx")
      .on(table.organizationId, table.slug)
      .where(isNotNull(table.organizationId)),
    p
      .index("mcp_connectors_org_curated_idx")
      .on(table.organizationId, table.isCurated),
    ...mcpConnectorPolicies(),
  ],
);

export const mcpOAuthClients = p.pgTable(
  "mcp_oauth_clients",
  {
    id: pUuid<"mcpOAuthClient">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    connectorId: safeUuid<"mcpConnector">("connector_id")
      .notNull()
      .references(() => mcpConnectors.id, { onDelete: "cascade" }),
    authorizationServerUrl: p.text("authorization_server_url").notNull(),
    clientId: p.text("client_id").notNull(),
    clientSecretEncrypted: bytea("client_secret_encrypted"),
    clientSecretIv: bytea("client_secret_iv"),
    registrationResponse: jsonb("registration_response")
      .$type<McpOAuthRegistrationResponse>()
      .notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("mcp_oauth_clients_org_connector_as_uidx")
      .on(
        table.organizationId,
        table.connectorId,
        table.authorizationServerUrl,
      ),
    p
      .index("mcp_oauth_clients_org_connector_idx")
      .on(table.organizationId, table.connectorId),
    p.index("mcp_oauth_clients_connector_idx").on(table.connectorId),
    ...mcpOAuthClientPolicies(),
  ],
);

export const MCP_AUTHORIZATION_REVIEW_STATUSES = [
  "needs_reapproval",
  "approved",
] as const;

export const mcpConnectorAuthorizationReviews = p.pgTable.withRLS(
  "mcp_connector_authorization_reviews",
  {
    organizationId: safeOrganizationId("organization_id").notNull(),
    connectorId: safeUuid<"mcpConnector">("connector_id").notNull(),
    observedIssuer: p.text("observed_issuer"),
    approvedIssuer: p.text("approved_issuer"),
    observedEndpointOrigins: jsonb("observed_endpoint_origins")
      .$type<string[]>()
      .notNull()
      .default([]),
    approvedEndpointOrigins: jsonb("approved_endpoint_origins").$type<
      string[]
    >(),
    status: p
      .text("status", { enum: MCP_AUTHORIZATION_REVIEW_STATUSES })
      .notNull()
      .default("needs_reapproval"),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p.primaryKey({
      columns: [table.organizationId, table.connectorId],
      name: "mcp_authorization_reviews_pk",
    }),
    p
      .foreignKey({
        columns: [table.organizationId],
        foreignColumns: [organization.id],
        name: "mcp_authorization_reviews_organization_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.connectorId],
        foreignColumns: [mcpConnectors.id],
        name: "mcp_authorization_reviews_connector_fk",
      })
      .onDelete("cascade"),
    p.check(
      "mcp_authorization_review_status_check",
      sql`${table.status} IN (${sql.join(
        MCP_AUTHORIZATION_REVIEW_STATUSES.map((status) => sql`${status}`),
        sql`, `,
      )})`,
    ),
    p.check(
      "mcp_authorization_review_approval_check",
      sql`${table.status} <> 'approved' OR ${table.approvedIssuer} IS NOT NULL`,
    ),
    p
      .index("mcp_connector_authorization_reviews_connector_idx")
      .on(table.connectorId),
    ...mcpConnectorAuthorizationReviewPolicies(),
  ],
);

export type CachedMcpToolDefinition = {
  description?: string;
  exposedName: string;
  inputSchema: { type: "object"; [key: string]: unknown };
  rawName: string;
  readOnlyHint?: boolean;
  title?: string;
};

export const MCP_RESPONSE_DISPOSITION = {
  normal: "normal",
  receiptOnly: "receipt-only",
} as const;
export const MCP_RESPONSE_DISPOSITIONS = [
  MCP_RESPONSE_DISPOSITION.normal,
  MCP_RESPONSE_DISPOSITION.receiptOnly,
] as const;

export const mcpUserConnections = p.pgTable(
  "mcp_user_connections",
  {
    id: pUuid<"mcpUserConnection">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    connectorId: safeUuid<"mcpConnector">("connector_id")
      .notNull()
      .references(() => mcpConnectors.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    responseDisposition: p
      .text("response_disposition", { enum: MCP_RESPONSE_DISPOSITIONS })
      .notNull()
      .default(MCP_RESPONSE_DISPOSITION.normal),
    responseTargetUrl: p.text("response_target_url"),
    accessTokenEncrypted: bytea("access_token_encrypted"),
    accessTokenIv: bytea("access_token_iv"),
    refreshTokenEncrypted: bytea("refresh_token_encrypted"),
    refreshTokenIv: bytea("refresh_token_iv"),
    staticTokenEncrypted: bytea("static_token_encrypted"),
    staticTokenIv: bytea("static_token_iv"),
    tokenType: p.varchar("token_type", { length: 40 }),
    scope: p.text(),
    resourceUrl: p.text("resource_url"),
    authorizationServerUrl: p.text("authorization_server_url"),
    refreshLeaseExpiresAt: timestamptz("refresh_lease_expires_at"),
    refreshRetryAfter: timestamptz("refresh_retry_after"),
    expiresAt: timestamptz("expires_at"),
    cachedTools: jsonb("cached_tools").$type<
      CachedMcpToolDefinition[] | null
    >(),
    cachedToolsRefreshedAt: timestamptz("cached_tools_refreshed_at"),
    // Metadata the server reports during the MCP `initialize` handshake,
    // captured with this user's credentials. Stored per-connection (not on
    // the shared connector) since a server may personalise it per account.
    serverVersion: p.text("server_version"),
    instructions: p.text(),
    status: p
      .text("status", { enum: MCP_CONNECTION_STATUSES })
      .notNull()
      .$type<McpConnectionStatus>(),
    enabled: p.boolean().notNull().default(true),
    lastUsedAt: timestamptz("last_used_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("mcp_user_connections_org_connector_user_uidx")
      .on(table.organizationId, table.connectorId, table.userId),
    p
      .index("mcp_user_connections_user_status_idx")
      .on(table.userId, table.status),
    p
      .index("mcp_user_connections_org_user_status_idx")
      .on(table.organizationId, table.userId, table.status),
    p
      .index("mcp_user_connections_org_user_enabled_status_idx")
      .on(table.organizationId, table.userId, table.enabled, table.status),
    p.index("mcp_user_connections_connector_idx").on(table.connectorId),
    p.check(
      "mcp_user_connections_response_disposition_check",
      sql`${table.responseDisposition} IN (${sql.join(
        MCP_RESPONSE_DISPOSITIONS.map((value) => sql.raw(`'${value}'`)),
        sql`, `,
      )})`,
    ),
    p.check(
      "mcp_user_connections_response_target_check",
      sql`${table.responseDisposition} = 'normal' OR ${table.responseTargetUrl} IS NOT NULL`,
    ),
    ...mcpUserConnectionPolicies(),
  ],
);

export const mcpOAuthState = p.pgTable(
  "mcp_oauth_state",
  {
    state: p.varchar({ length: 128 }).primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    connectorId: safeUuid<"mcpConnector">("connector_id")
      .notNull()
      .references(() => mcpConnectors.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    codeVerifier: p.text("code_verifier").notNull(),
    redirectUri: p.text("redirect_uri").notNull(),
    resourceUrl: p.text("resource_url").notNull(),
    authorizationServerUrl: p.text("authorization_server_url").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("mcp_oauth_state_created_idx").on(table.createdAt),
    p
      .index("mcp_oauth_state_org_user_idx")
      .on(table.organizationId, table.userId),
    ...mcpOAuthStatePolicies(),
  ],
);

// -- User Files (private user-owned uploads) --
