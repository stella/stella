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
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
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
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
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

export type CachedMcpToolDefinition = {
  description?: string;
  exposedName: string;
  inputSchema: { type: "object"; [key: string]: unknown };
  rawName: string;
  readOnlyHint?: boolean;
  title?: string;
};

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
    expiresAt: p.timestamp("expires_at"),
    cachedTools: jsonb("cached_tools").$type<
      CachedMcpToolDefinition[] | null
    >(),
    cachedToolsRefreshedAt: p.timestamp("cached_tools_refreshed_at"),
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
    lastUsedAt: p.timestamp("last_used_at"),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
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
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
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
