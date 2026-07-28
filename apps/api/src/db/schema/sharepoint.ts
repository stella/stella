import {
  bytea,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  sharepointConnectionPolicies,
  sharepointOAuthStatePolicies,
  user,
} from "./common";

/**
 * Lifecycle of a delegated Microsoft Graph connection. Two states, no
 * "unknown" limbo:
 *   - "connected": tokens are present and usable (subject to refresh).
 *   - "reconnect_required": a token refresh failed (e.g. the user revoked
 *     consent or the refresh token expired). The row is kept so the UI can
 *     surface a reconnect prompt; it is never silently usable.
 */
export const SHAREPOINT_CONNECTION_STATUSES = [
  "connected",
  "reconnect_required",
] as const;
export type SharepointConnectionStatus =
  (typeof SHAREPOINT_CONNECTION_STATUSES)[number];

// Per user+org delegated Graph connection. Tokens are encrypted at rest with
// the same per-org AES-256-GCM envelope the MCP connection tokens use. There
// is no service account: every stored token is the user's own delegated
// grant, so Microsoft enforces the ACLs on every downstream read.
export const sharepointConnections = p.pgTable(
  "sharepoint_connections",
  {
    id: pUuid<"sharepointConnection">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessTokenEncrypted: bytea("access_token_encrypted").notNull(),
    accessTokenIv: bytea("access_token_iv").notNull(),
    refreshTokenEncrypted: bytea("refresh_token_encrypted"),
    refreshTokenIv: bytea("refresh_token_iv"),
    tokenType: p.varchar("token_type", { length: 40 }),
    /** Space-delimited scopes Microsoft actually granted. */
    scope: p.text("scope"),
    /** Display-only Microsoft account identifier (userPrincipalName). */
    accountLabel: p.text("account_label"),
    expiresAt: p.timestamp("expires_at", { withTimezone: true }),
    status: p
      .text("status", { enum: SHAREPOINT_CONNECTION_STATUSES })
      .notNull()
      .$type<SharepointConnectionStatus>(),
    lastUsedAt: p.timestamp("last_used_at", { withTimezone: true }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("sharepoint_connections_org_user_uidx")
      .on(table.organizationId, table.userId),
    p
      .index("sharepoint_connections_org_user_status_idx")
      .on(table.organizationId, table.userId, table.status),
    ...sharepointConnectionPolicies(),
  ],
);

// Short-lived per-request OAuth state consumed by the callback. PKCE verifier
// and the exact redirect URI are pinned here so the callback re-derives them
// from server state, never from the request.
export const sharepointOAuthState = p.pgTable(
  "sharepoint_oauth_state",
  {
    state: p.varchar({ length: 128 }).primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    codeVerifier: p.text("code_verifier").notNull(),
    redirectUri: p.text("redirect_uri").notNull(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("sharepoint_oauth_state_created_idx").on(table.createdAt),
    p
      .index("sharepoint_oauth_state_org_user_idx")
      .on(table.organizationId, table.userId),
    ...sharepointOAuthStatePolicies(),
  ],
);
