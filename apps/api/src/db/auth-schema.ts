import { defineRelationsPart, sql } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { jsonb } from "@/api/db/columns";
import {
  authMemberPolicies,
  authOrganizationPolicies,
  authUserPolicies,
  denyStellaAccessPolicies,
} from "@/api/db/rls";

export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    timezoneId: text("timezone_id").default("UTC").notNull(),
    preferredName: text("preferred_name"),
    wordEditShortcut: text("word_edit_shortcut"),
    twoFactorEnabled: boolean("two_factor_enabled").default(false).notNull(),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // Keyset pagination over registrations (operator observability)
    // orders by (created_at, id); without this the read is a table scan.
    index("user_createdAt_idx").on(table.createdAt, table.id),
    ...authUserPolicies(),
  ],
);

type AuthUserColumnNameByField = Record<
  keyof InferSelectModel<typeof user>,
  string
>;

/**
 * Columns the scoped `stella` role may read from Better Auth's
 * `user` table. Better Auth's Drizzle adapter fetches full user
 * rows during session resolution, so every column on this table
 * needs an explicit grant decision here and in migrations.
 */
export const AUTH_USER_STELLA_SELECT_COLUMNS = {
  id: "id",
  name: "name",
  email: "email",
  emailVerified: "email_verified",
  image: "image",
  timezoneId: "timezone_id",
  preferredName: "preferred_name",
  wordEditShortcut: "word_edit_shortcut",
  twoFactorEnabled: "two_factor_enabled",
  deletedAt: "deleted_at",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const satisfies AuthUserColumnNameByField;

export const AUTH_USER_STELLA_SELECT_COLUMN_NAMES = Object.values(
  AUTH_USER_STELLA_SELECT_COLUMNS,
);

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id"),
  },
  (table) => [
    index("session_userId_activeOrgId_idx").on(
      table.userId,
      table.activeOrganizationId,
    ),
    ...denyStellaAccessPolicies(),
  ],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("account_userId_idx").on(table.userId),
    uniqueIndex("account_credential_singleton_uidx")
      .on(table.providerId)
      .where(sql`${table.providerId} = 'credential'`),
    ...denyStellaAccessPolicies(),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("verification_identifier_idx").on(table.identifier),
    ...denyStellaAccessPolicies(),
  ],
);

// TOTP secret + backup codes are encrypted by Better Auth before storage
// (secret always; backupCodes per the plugin's default `storeBackupCodes:
// "encrypted"`), but the columns are still treated as auth secrets: deny
// the scoped `stella` role entirely, mirroring `session` / `account`.
export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true).notNull(),
    // Account-lockout bookkeeping written by Better Auth's 2FA verification
    // path (see node_modules/better-auth/dist/plugins/two-factor/schema.mjs and
    // verify-two-factor.mjs): `failedVerificationCount` is incremented per
    // failed factor check and reset on success; `lockedUntil` holds the
    // lockout expiry once the failure budget is spent. The plugin's default
    // `accountLockout` is enabled, so these columns must exist for it to work.
    failedVerificationCount: integer("failed_verification_count")
      .default(0)
      .notNull(),
    lockedUntil: timestamp("locked_until"),
  },
  (table) => [
    // UNIQUE, not a plain index: Better Auth's `/two-factor/enable` does a
    // (non-atomic) delete-all-then-insert per user, so two enable requests
    // racing (two tabs, or another client while the settings dialog is open)
    // can both insert and leave the account with multiple secrets/backup-code
    // sets — verification/sign-in then reads only one row, so the QR the user
    // scanned may not be the row used to verify. The uniqueness serializes
    // enrollment: the losing insert fails instead of duplicating the row.
    uniqueIndex("two_factor_user_id_uidx").on(table.userId),
    ...denyStellaAccessPolicies(),
  ],
);

export const organization = pgTable(
  "organization",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    createdAt: timestamp("created_at").notNull(),
    metadata: text("metadata"),
  },
  (table) => [
    uniqueIndex("organization_slug_uidx").on(table.slug),
    ...authOrganizationPolicies(),
  ],
);

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").default("member").notNull(),
    lastActiveWorkspaceId: text("last_active_workspace_id"),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    index("member_organizationId_idx").on(table.organizationId),
    index("member_userId_idx").on(table.userId),
    index("member_lastActiveWorkspaceId_idx").on(table.lastActiveWorkspaceId),
    ...authMemberPolicies(),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitation_organizationId_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
    ...denyStellaAccessPolicies(),
  ],
);

export const jwks = pgTable(
  "jwks",
  {
    id: text("id").primaryKey(),
    alg: text("alg"),
    crv: text("crv"),
    publicKey: text("public_key").notNull(),
    privateKey: text("private_key").notNull(),
    createdAt: timestamp("created_at").notNull(),
    expiresAt: timestamp("expires_at"),
  },
  () => [...denyStellaAccessPolicies()],
);

/**
 * Storage for `@better-auth/api-key`. Every column name here mirrors a field the
 * plugin declares (see `apiKeySchema` in the package): the drizzle adapter maps
 * the plugin's camelCase field names onto these object keys, so renaming a key
 * silently breaks the plugin at runtime rather than at build time.
 *
 * `referenceId` carries a **user** id, not an organization id: the plugin is
 * configured with `references: "user"` (see the `apiKey(...)` registration in
 * `lib/auth.ts`), which is what lets a key resolve to a real principal that
 * holds a `member` row and therefore an RLS identity. The owning organization
 * travels in `metadata`.
 *
 * The cascade below covers a hard user delete, but it is NOT the revocation
 * path that matters: account deletion soft-deletes the `user` row (anonymize +
 * `deletedAt`) and never hard-deletes it, so this cascade does not fire for a
 * closed account. Machine keys are purged explicitly in
 * `revokeAuthCredentialsAndInvitations` (`lib/account-deletion-steps.ts`), and
 * `account-deletion-coverage.test.ts` fails if that step is ever dropped.
 */
export const apikey = pgTable(
  "apikey",
  {
    id: text("id").primaryKey(),
    configId: text("config_id").default("default").notNull(),
    name: text("name"),
    start: text("start"),
    prefix: text("prefix"),
    key: text("key").notNull(),
    referenceId: text("reference_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: timestamp("last_refill_at"),
    enabled: boolean("enabled").default(true).notNull(),
    rateLimitEnabled: boolean("rate_limit_enabled").default(true).notNull(),
    rateLimitTimeWindow: integer("rate_limit_time_window"),
    rateLimitMax: integer("rate_limit_max"),
    requestCount: integer("request_count").default(0).notNull(),
    remaining: integer("remaining"),
    lastRequest: timestamp("last_request"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (table) => [
    // Unique rather than the plugin's plain index: `key` holds a SHA-256 digest
    // and the verification path resolves a credential by it, so two rows sharing
    // one digest is a corruption we want the database to refuse outright.
    uniqueIndex("apikey_key_uidx").on(table.key),
    index("apikey_reference_id_idx").on(table.referenceId),
    index("apikey_config_id_idx").on(table.configId),
    // Declared here so the generated schema matches the migration: machine-key
    // lifecycle reads filter on the owning organization, which lives inside
    // `metadata`, and an unindexed JSON filter is what `/conventions-db`
    // forbids. Both are partial on `metadata IS NOT NULL` and built
    // CONCURRENTLY by the migration, since a plain build would lock out every
    // credential verification while it ran.
    index("apikey_metadata_organization_id_idx")
      .on(sql`((${table.metadata}::jsonb ->> 'organizationId'))`)
      .where(sql`${table.metadata} IS NOT NULL`),
    index("apikey_org_keyset_idx")
      .on(
        sql`((${table.metadata}::jsonb ->> 'organizationId'))`,
        sql`${table.createdAt} DESC`,
        sql`${table.id} DESC`,
      )
      .where(sql`${table.metadata} IS NOT NULL`),
    ...denyStellaAccessPolicies(),
  ],
);

export const oauthClient = pgTable(
  "oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    disabled: boolean("disabled").default(false).notNull(),
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    subjectType: text("subject_type"),
    scopes: text("scopes").array(),
    userId: text("user_id").references(() => user.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts").array(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").array().notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    grantTypes: text("grant_types").array(),
    responseTypes: text("response_types").array(),
    public: boolean("public"),
    type: text("type"),
    requirePKCE: boolean("require_pkce"),
    referenceId: text("reference_id"),
    metadata: jsonb("metadata"),
  },
  (table) => [
    uniqueIndex("oauth_client_client_id_uidx").on(table.clientId),
    index("oauth_client_user_id_idx").on(table.userId),
    index("oauth_client_reference_id_idx").on(table.referenceId),
    ...denyStellaAccessPolicies(),
  ],
);

export const oauthRefreshToken = pgTable(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, {
        onDelete: "cascade",
      }),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, {
        onDelete: "cascade",
      }),
    referenceId: text("reference_id"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    revoked: timestamp("revoked"),
    authTime: timestamp("auth_time"),
    scopes: text("scopes").array().notNull(),
  },
  (table) => [
    index("oauth_refresh_token_client_id_idx").on(table.clientId),
    index("oauth_refresh_token_session_id_idx").on(table.sessionId),
    index("oauth_refresh_token_user_id_idx").on(table.userId),
    index("oauth_refresh_token_reference_id_idx").on(table.referenceId),
    ...denyStellaAccessPolicies(),
  ],
);

export const oauthAccessToken = pgTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, {
        onDelete: "cascade",
      }),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").references(() => user.id, {
      onDelete: "cascade",
    }),
    referenceId: text("reference_id"),
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    scopes: text("scopes").array().notNull(),
  },
  (table) => [
    index("oauth_access_token_client_id_idx").on(table.clientId),
    index("oauth_access_token_session_id_idx").on(table.sessionId),
    index("oauth_access_token_user_id_idx").on(table.userId),
    index("oauth_access_token_reference_id_idx").on(table.referenceId),
    index("oauth_access_token_refresh_id_idx").on(table.refreshId),
    ...denyStellaAccessPolicies(),
  ],
);

export const oauthConsent = pgTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, {
        onDelete: "cascade",
      }),
    userId: text("user_id").references(() => user.id, {
      onDelete: "cascade",
    }),
    referenceId: text("reference_id"),
    scopes: text("scopes").array().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("oauth_consent_client_id_idx").on(table.clientId),
    index("oauth_consent_user_id_idx").on(table.userId),
    index("oauth_consent_reference_id_idx").on(table.referenceId),
    ...denyStellaAccessPolicies(),
  ],
);

export const authSchema = {
  user,
  session,
  account,
  verification,
  twoFactor,
  organization,
  member,
  invitation,
  jwks,
  apikey,
  oauthClient,
  oauthAccessToken,
  oauthRefreshToken,
  oauthConsent,
};

export const authRelationsPart = defineRelationsPart(authSchema, (r) => ({
  user: {
    sessions: r.many.session({ from: r.user.id, to: r.session.userId }),
    accounts: r.many.account({ from: r.user.id, to: r.account.userId }),
    members: r.many.member({ from: r.user.id, to: r.member.userId }),
    invitations: r.many.invitation({
      from: r.user.id,
      to: r.invitation.inviterId,
    }),
    oauthClients: r.many.oauthClient({
      from: r.user.id,
      to: r.oauthClient.userId,
    }),
    oauthAccessTokens: r.many.oauthAccessToken({
      from: r.user.id,
      to: r.oauthAccessToken.userId,
    }),
    oauthRefreshTokens: r.many.oauthRefreshToken({
      from: r.user.id,
      to: r.oauthRefreshToken.userId,
    }),
    oauthConsents: r.many.oauthConsent({
      from: r.user.id,
      to: r.oauthConsent.userId,
    }),
    twoFactors: r.many.twoFactor({ from: r.user.id, to: r.twoFactor.userId }),
  },
  session: {
    user: r.one.user({ from: r.session.userId, to: r.user.id }),
    oauthAccessTokens: r.many.oauthAccessToken({
      from: r.session.id,
      to: r.oauthAccessToken.sessionId,
    }),
    oauthRefreshTokens: r.many.oauthRefreshToken({
      from: r.session.id,
      to: r.oauthRefreshToken.sessionId,
    }),
  },
  account: {
    user: r.one.user({ from: r.account.userId, to: r.user.id }),
  },
  twoFactor: {
    user: r.one.user({ from: r.twoFactor.userId, to: r.user.id }),
  },
  organization: {
    members: r.many.member({
      from: r.organization.id,
      to: r.member.organizationId,
    }),
    invitations: r.many.invitation({
      from: r.organization.id,
      to: r.invitation.organizationId,
    }),
  },
  member: {
    organization: r.one.organization({
      from: r.member.organizationId,
      to: r.organization.id,
    }),
    user: r.one.user({ from: r.member.userId, to: r.user.id }),
  },
  invitation: {
    organization: r.one.organization({
      from: r.invitation.organizationId,
      to: r.organization.id,
    }),
    inviter: r.one.user({
      from: r.invitation.inviterId,
      to: r.user.id,
    }),
  },
  oauthClient: {
    user: r.one.user({
      from: r.oauthClient.userId,
      to: r.user.id,
    }),
    accessTokens: r.many.oauthAccessToken({
      from: r.oauthClient.clientId,
      to: r.oauthAccessToken.clientId,
    }),
    refreshTokens: r.many.oauthRefreshToken({
      from: r.oauthClient.clientId,
      to: r.oauthRefreshToken.clientId,
    }),
    consents: r.many.oauthConsent({
      from: r.oauthClient.clientId,
      to: r.oauthConsent.clientId,
    }),
  },
  oauthRefreshToken: {
    client: r.one.oauthClient({
      from: r.oauthRefreshToken.clientId,
      to: r.oauthClient.clientId,
    }),
    session: r.one.session({
      from: r.oauthRefreshToken.sessionId,
      to: r.session.id,
    }),
    user: r.one.user({
      from: r.oauthRefreshToken.userId,
      to: r.user.id,
    }),
    accessTokens: r.many.oauthAccessToken({
      from: r.oauthRefreshToken.id,
      to: r.oauthAccessToken.refreshId,
    }),
  },
  oauthAccessToken: {
    client: r.one.oauthClient({
      from: r.oauthAccessToken.clientId,
      to: r.oauthClient.clientId,
    }),
    session: r.one.session({
      from: r.oauthAccessToken.sessionId,
      to: r.session.id,
    }),
    user: r.one.user({
      from: r.oauthAccessToken.userId,
      to: r.user.id,
    }),
    refreshToken: r.one.oauthRefreshToken({
      from: r.oauthAccessToken.refreshId,
      to: r.oauthRefreshToken.id,
    }),
  },
  oauthConsent: {
    client: r.one.oauthClient({
      from: r.oauthConsent.clientId,
      to: r.oauthClient.clientId,
    }),
    user: r.one.user({
      from: r.oauthConsent.userId,
      to: r.user.id,
    }),
  },
}));
