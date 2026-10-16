import {
  bytea,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  microsoft365ConnectionPolicies,
  microsoft365OAuthStatePolicies,
  user,
  timestamptz,
} from "./common";

/**
 * Lifecycle of a delegated Microsoft Graph connection. Two states, no
 * "unknown" limbo:
 *   - "connected": tokens are present and usable (subject to refresh).
 *   - "reconnect_required": a token refresh failed (e.g. the user revoked
 *     consent or the refresh token expired). The row is kept so the UI can
 *     surface a reconnect prompt; it is never silently usable.
 */
export const MICROSOFT365_CONNECTION_STATUSES = [
  "connected",
  "reconnect_required",
] as const;
export type Microsoft365ConnectionStatus =
  (typeof MICROSOFT365_CONNECTION_STATUSES)[number];

// Per user+org delegated Graph connection. Tokens are encrypted at rest with
// the same per-org AES-256-GCM envelope the MCP connection tokens use. There
// is no service account: every stored token is the user's own delegated
// grant, so Microsoft enforces the ACLs on every downstream read.
export const microsoft365Connections = p.pgTable(
  "microsoft365_connections",
  {
    id: pUuid<"microsoft365Connection">().primaryKey(),
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
    expiresAt: timestamptz("expires_at"),
    status: p
      .text("status", { enum: MICROSOFT365_CONNECTION_STATUSES })
      .notNull()
      .$type<Microsoft365ConnectionStatus>(),
    lastUsedAt: timestamptz("last_used_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("microsoft365_connections_org_user_uidx")
      .on(table.organizationId, table.userId),
    p
      .index("microsoft365_connections_org_user_status_idx")
      .on(table.organizationId, table.userId, table.status),
    ...microsoft365ConnectionPolicies(),
  ],
);

// Short-lived per-request OAuth state consumed by the callback. PKCE verifier
// and the exact redirect URI are pinned here so the callback re-derives them
// from server state, never from the request.
export const microsoft365OAuthState = p.pgTable(
  "microsoft365_oauth_state",
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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("microsoft365_oauth_state_created_idx").on(table.createdAt),
    p
      .index("microsoft365_oauth_state_org_user_idx")
      .on(table.organizationId, table.userId),
    ...microsoft365OAuthStatePolicies(),
  ],
);
