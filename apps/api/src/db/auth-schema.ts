import { defineRelationsPart, inArray, sql } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";
import { UI_LOCALES } from "@stll/locales";

import { jsonb, sealedText, timestamptz } from "@/api/db/columns";
import {
  authMemberPolicies,
  authOrganizationPolicies,
  authUserPolicies,
  denyStellaAccessPolicies,
} from "@/api/db/rls";
import {
  admitSsoOidcConfig,
  admitSsoSamlConfig,
} from "@/api/lib/db/sso-provider-config";
import { ACCOUNT_EMAIL_UNDELIVERABLE_REASONS } from "@/api/lib/email/deliverability-contract";
import {
  SYNTHETIC_PRINCIPAL,
  SYNTHETIC_SESSION_PREFIX,
} from "@/api/lib/synthetic-principal/constants";

const USER_LOCALES = [
  "en",
  ...UI_LOCALES.filter((locale) => locale !== "en"),
] as const;

export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    // The UI locale the user picked, shared across devices. Null until they
    // pick one: the browser's language applies meanwhile.
    locale: text("locale", { enum: USER_LOCALES }),
    timezoneId: text("timezone_id").default("UTC").notNull(),
    preferredName: text("preferred_name"),
    // Null or document follows the document language; a UI locale overrides it.
    readerAnswerLanguage: text("reader_answer_language", {
      enum: ["document", ...UI_LOCALES],
    }),
    wordEditShortcut: text("word_edit_shortcut"),
    // Per-user keyboard-shortcut rebindings, serialized as a JSON object of
    // `{ [shortcutId]: "Mod+K" }`. Null when the user has never rebound a
    // shortcut (the default registry then applies unchanged). Structurally
    // validated and length-capped before persistence (see `user-shortcuts.ts`).
    userShortcuts: text("user_shortcuts"),
    // Serialized JSON map of onboarding-guide tour id -> status. Rides the
    // session query so in-app guide progress follows the user across devices
    // without a separate table or per-route request. Shape/length validated in
    // the Better Auth create/update hooks.
    guideProgress: text("guide_progress"),
    // ISO 3166-1 alpha-2 code captured from the edge at signup; seeds the
    // practice-jurisdiction suggestion in onboarding. Null when the edge
    // did not advertise a country (local dev, self-hosted without a proxy).
    detectedCountry: text("detected_country"),
    twoFactorEnabled: boolean("two_factor_enabled").default(false).notNull(),
    // The mail provider refused this address: which address (so a changed
    // email is deliverable again), why, and since when. All null, or all set.
    // Written only by the account-row owner from the provider's own events.
    emailUndeliverableAddress: text("email_undeliverable_address"),
    emailUndeliverableReason: text("email_undeliverable_reason"),
    emailUndeliverableAt: timestamptz("email_undeliverable_at"),
    deletedAt: timestamptz("deleted_at"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    check(
      "user_locale_supported_check",
      sql`${table.locale} IN (${sql.join(
        UI_LOCALES.map((locale) => sql`${locale}`),
        sql`, `,
      )})`,
    ),
    // Keyset pagination over registrations (operator observability)
    // orders by (created_at, id); without this the read is a table scan.
    index("user_createdAt_idx").on(table.createdAt, table.id),
    check(
      "user_email_undeliverable_check",
      sql`(${table.emailUndeliverableAddress} IS NULL AND ${table.emailUndeliverableReason} IS NULL AND ${table.emailUndeliverableAt} IS NULL) OR (${table.emailUndeliverableAddress} IS NOT NULL AND ${table.emailUndeliverableAt} IS NOT NULL AND ${table.emailUndeliverableReason} IS NOT NULL AND ${inArray(table.emailUndeliverableReason, ACCOUNT_EMAIL_UNDELIVERABLE_REASONS)})`,
    ),
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
  locale: "locale",
  timezoneId: "timezone_id",
  preferredName: "preferred_name",
  readerAnswerLanguage: "reader_answer_language",
  wordEditShortcut: "word_edit_shortcut",
  userShortcuts: "user_shortcuts",
  guideProgress: "guide_progress",
  detectedCountry: "detected_country",
  twoFactorEnabled: "two_factor_enabled",
  emailUndeliverableAddress: "email_undeliverable_address",
  emailUndeliverableReason: "email_undeliverable_reason",
  emailUndeliverableAt: "email_undeliverable_at",
  deletedAt: "deleted_at",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const satisfies AuthUserColumnNameByField;

export const AUTH_USER_STELLA_SELECT_COLUMN_NAMES = Object.values(
  AUTH_USER_STELLA_SELECT_COLUMNS,
);

const SESSION_REFRESH_MODES = ["automatic", "fixed"] as const;

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamptz("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id"),
    // OAuth consent that owns this handoff session and its revocation.
    originConsentId: text("origin_consent_id").references(
      () => oauthConsent.id,
      {
        onDelete: "cascade",
      },
    ),
    // Fixed expiry for text handoffs; session refresh never extends this cap.
    handoffAbsoluteExpiresAt: timestamptz("handoff_absolute_expires_at"),
    refreshMode: text("refresh_mode", { enum: SESSION_REFRESH_MODES })
      .default("automatic")
      .notNull(),
    lastSeenAt: timestamptz("last_seen_at"),
    priorTokenHash: text("prior_token_hash"),
    priorTokenExpiresAt: timestamptz("prior_token_expires_at"),
    /**
     * The `sso_provider` row whose sign-in created this session, written only
     * by that provider's callback; null for every other sign-in. No foreign
     * key: a deleted provider leaves an id that matches no row, which an
     * organization requiring SSO reads as a session it did not create.
     */
    ssoProviderId: text("sso_provider_id"),
  },
  (table) => [
    check(
      "session_refreshMode_check",
      inArray(table.refreshMode, SESSION_REFRESH_MODES),
    ),
    check(
      "session_monitoring_principal_check",
      sql`(${table.id} NOT LIKE 'synthetic-session-%' OR ${table.userId} = ${sql.raw(`'${SYNTHETIC_PRINCIPAL.user.id}'`)}) AND (${table.id} NOT LIKE 'smoke-session-%' OR ${table.userId} IN ('smoke-user-stella', 'smoke-ai-user-stella'))`,
    ),
    index("session_monitoring_id_idx")
      .on(table.id)
      .where(
        sql`${table.id} LIKE ${sql.raw(`'${SYNTHETIC_SESSION_PREFIX}%'`)}`,
      ),
    index("session_userId_activeOrgId_idx").on(
      table.userId,
      table.activeOrganizationId,
    ),
    uniqueIndex("session_priorTokenHash_idx").on(table.priorTokenHash),
    index("session_originConsentId_idx").on(table.originConsentId),
    ...denyStellaAccessPolicies(),
  ],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    // Better Auth wrote this from 1.7.0 to 1.7.2 and retracted it in 1.7.3.
    // Nullable so the library can stop writing it; existing rows keep the
    // provenance the 1.7 backfill derived.
    issuer: text("issuer"),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamptz("access_token_expires_at"),
    refreshTokenExpiresAt: timestamptz("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    /**
     * For an SSO identity, the `sso_provider` row (one provider generation:
     * its issuer and organization never change) that created it; null for
     * every other account. A provider id reused by a later row does not
     * reach identities an earlier row created.
     */
    ssoProviderId: text("sso_provider_id"),
  },
  (table) => [
    index("account_userId_idx").on(table.userId),
    // One account row per external identity. This is the pair Better Auth
    // links accounts by, so it holds the guarantee the retracted
    // (issuer, account_id) index used to.
    uniqueIndex("account_provider_account_id_uidx").on(
      table.providerId,
      table.accountId,
    ),
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
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("verification_identifier_idx").on(table.identifier),
    index("verification_expires_at_idx").on(table.expiresAt),
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
    lockedUntil: timestamptz("locked_until"),
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
    createdAt: timestamptz("created_at").notNull(),
    metadata: text("metadata"),
  },
  (table) => [
    uniqueIndex("organization_slug_uidx").on(table.slug),
    check(
      "organization_monitoring_slug_check",
      sql`${table.slug} <> ${sql.raw(`'${SYNTHETIC_PRINCIPAL.org.slug}'`)} OR ${table.id} = ${sql.raw(`'${SYNTHETIC_PRINCIPAL.org.id}'`)}`,
    ),
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
    /** An additional monetary-visibility grant; management roles hold it independently. */
    billingAccess: boolean("billing_access").default(false).notNull(),
    lastActiveWorkspaceId: text("last_active_workspace_id"),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    index("member_organizationId_idx").on(table.organizationId),
    check(
      "member_single_product_role",
      sql`${table.role} IN (${sql.join(
        ORGANIZATION_ROLE_NAMES.map((role) => sql.raw(`'${role}'`)),
        sql`, `,
      )})`,
    ),
    index("member_userId_idx").on(table.userId),
    index("member_lastActiveWorkspaceId_idx").on(table.lastActiveWorkspaceId),
    // One membership per user per organization (the auth layer already
    // guarantees this; the index makes it referenceable so dependent
    // rows can bind to the membership and cascade with it).
    uniqueIndex("member_organization_id_user_id_uidx").on(
      table.organizationId,
      table.userId,
    ),
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
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitation_organizationId_idx").on(table.organizationId),
    check(
      "invitation_single_product_role",
      sql`${table.role} IS NOT NULL AND ${table.role} IN (${sql.join(
        ORGANIZATION_ROLE_NAMES.map((role) => sql.raw(`'${role}'`)),
        sql`, `,
      )})`,
    ),
    index("invitation_email_idx").on(table.email),
    ...denyStellaAccessPolicies(),
  ],
);

/**
 * The form of an SSO provider id: `sso_` and a lowercase slug. Better-auth
 * signs an account in by (provider id, subject), so a provider named after a
 * social provider (`google`) could assert that provider's subjects; the
 * prefix keeps the two namespaces apart.
 */
export const SSO_PROVIDER_ID_PATTERN = "^sso_[a-z0-9][a-z0-9_-]{0,62}$";

/**
 * Row security is forced on the SSO policy table, so even the owner role
 * reaches it only through this policy; the request role has none.
 */
const tableOwnerAccess = (table: string) => {
  const isOwner = sql.raw(
    `current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.${table}'::regclass)`,
  );
  return pgPolicy(`${table}_owner_access`, {
    for: "all",
    to: "public",
    using: isOwner,
    withCheck: isOwner,
  });
};

/**
 * An organization's OIDC identity provider, read by `@better-auth/sso` during
 * sign-in. Column keys mirror the plugin's field names. Rows are written only
 * by server code: the plugin's own provider endpoints are disabled.
 */
export const ssoProvider = pgTable(
  "sso_provider",
  {
    id: text("id").primaryKey(),
    /** The provider id in sign-in and callback paths; see the pattern above. */
    providerId: text("provider_id").notNull(),
    /** Optional admin-chosen label shown in settings and sign-in prompts. */
    displayName: text("display_name"),
    /** The organization whose members this provider signs in. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** The OIDC issuer the ID token's `iss` must equal. */
    issuer: text("issuer").notNull(),
    /**
     * The email domains, comma-separated, whose addresses this provider may
     * create accounts for.
     */
    domain: text("domain").notNull(),
    /** The plugin's OIDC configuration JSON, client secret included, sealed. */
    oidcConfig: sealedText(
      "stella:sealed-text:v1:sso_provider.oidc_config",
      admitSsoOidcConfig,
    )("oidc_config"),
    /** The plugin's SAML 2.0 configuration JSON, IdP certificate included, sealed. */
    samlConfig: sealedText(
      "stella:sealed-text:v1:sso_provider.saml_config",
      admitSsoSamlConfig,
    )("saml_config"),
    /** The account that registered the provider, as the plugin records it. */
    userId: text("user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("sso_provider_provider_id_uidx").on(table.providerId),
    index("sso_provider_organization_id_idx").on(table.organizationId),
    index("sso_provider_user_id_idx").on(table.userId),
    check(
      "sso_provider_provider_id_check",
      sql`${table.providerId} ~ ${sql.raw(`'${SSO_PROVIDER_ID_PATTERN}'`)}`,
    ),
    check(
      "sso_provider_single_protocol_check",
      sql`(${table.oidcConfig} IS NOT NULL AND ${table.samlConfig} IS NULL) OR (${table.oidcConfig} IS NULL AND ${table.samlConfig} IS NOT NULL)`,
    ),
    ...denyStellaAccessPolicies(),
  ],
);

/** Whether an organization's members must sign in through its SSO provider. */
export const ORGANIZATION_SSO_REQUIREMENTS = ["optional", "required"] as const;
export const ORGANIZATION_SSO_PROVISIONING_MODES = [
  "invite_only",
  "admin_approval",
  "jit_active",
] as const;
export const ORGANIZATION_SSO_PENDING_REASONS = [
  "admin_approval",
  "seat_limit_reached",
] as const;
export const ORGANIZATION_SSO_PENDING_STATUSES = [
  "pending",
  "approved",
  "rejected",
] as const;

/**
 * An organization's single sign-on policy; no row means SSO is optional.
 * Kept apart from the providers so deleting or replacing a provider never
 * lifts the requirement.
 */
export const organizationSsoPolicy = pgTable(
  "organization_sso_policy",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * `required`: only a session one of the organization's providers created
     * reaches the organization.
     */
    requirement: text("requirement", {
      enum: ORGANIZATION_SSO_REQUIREMENTS,
    }).notNull(),
    provisioningMode: text("provisioning_mode", {
      enum: ORGANIZATION_SSO_PROVISIONING_MODES,
    })
      .default("invite_only")
      .notNull(),
    seatLimit: integer("seat_limit"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    check(
      "organization_sso_policy_requirement_check",
      inArray(table.requirement, ORGANIZATION_SSO_REQUIREMENTS),
    ),
    check(
      "organization_sso_policy_provisioning_mode_check",
      inArray(table.provisioningMode, ORGANIZATION_SSO_PROVISIONING_MODES),
    ),
    check(
      "organization_sso_policy_seat_limit_check",
      sql`${table.seatLimit} IS NULL OR ${table.seatLimit} >= 1`,
    ),
    tableOwnerAccess("organization_sso_policy"),
    ...denyStellaAccessPolicies(),
  ],
);

const ORGANIZATION_SSO_DOMAIN_PATTERN =
  "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$";

/**
 * Verified email domains owned by an organization for SSO sign-in discovery.
 * Kept separate from `sso_provider` so replacing a provider never requires
 * re-verifying DNS. Only one organization may hold a verified claim on a
 * domain at a time.
 */
export const organizationSsoDomain = pgTable(
  "organization_sso_domain",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Normalized lowercase hostname (e.g. `acme.example.com`). */
    domain: text("domain").notNull(),
    /** Token expected in the DNS TXT record (`stella-sso-verify=...`). */
    verificationToken: text("verification_token").notNull(),
    verifiedAt: timestamptz("verified_at"),
    lastCheckedAt: timestamptz("last_checked_at"),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("organization_sso_domain_org_domain_uidx").on(
      table.organizationId,
      table.domain,
    ),
    uniqueIndex("organization_sso_domain_verified_uidx")
      .on(table.domain)
      .where(sql`${table.verifiedAt} IS NOT NULL`),
    index("organization_sso_domain_organization_id_idx").on(
      table.organizationId,
    ),
    index("organization_sso_domain_created_by_idx").on(table.createdBy),
    check(
      "organization_sso_domain_domain_check",
      sql`${table.domain} ~ ${sql.raw(`'${ORGANIZATION_SSO_DOMAIN_PATTERN}'`)}`,
    ),
    tableOwnerAccess("organization_sso_domain"),
    ...denyStellaAccessPolicies(),
  ],
);

/**
 * Pending SSO membership requests awaiting admin approval or an open seat.
 * Kept apart from `member` so pending users hold no workspace access until
 * an administrator approves them.
 */
export const organizationSsoPendingMember = pgTable(
  "organization_sso_pending_member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name"),
    ssoProviderId: text("sso_provider_id"),
    reason: text("reason", {
      enum: ORGANIZATION_SSO_PENDING_REASONS,
    }).notNull(),
    status: text("status", {
      enum: ORGANIZATION_SSO_PENDING_STATUSES,
    })
      .default("pending")
      .notNull(),
    reviewedBy: text("reviewed_by").references(() => user.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamptz("reviewed_at"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "org_sso_pending_member_org_fk",
      columns: [table.organizationId],
      foreignColumns: [organization.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "org_sso_pending_member_provider_fk",
      columns: [table.ssoProviderId],
      foreignColumns: [ssoProvider.id],
    }).onDelete("set null"),
    uniqueIndex("organization_sso_pending_member_org_user_uidx").on(
      table.organizationId,
      table.userId,
    ),
    index("organization_sso_pending_member_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    index("organization_sso_pending_member_user_id_idx").on(table.userId),
    check(
      "organization_sso_pending_member_reason_check",
      inArray(table.reason, ORGANIZATION_SSO_PENDING_REASONS),
    ),
    check(
      "organization_sso_pending_member_status_check",
      inArray(table.status, ORGANIZATION_SSO_PENDING_STATUSES),
    ),
    check(
      "org_sso_pending_member_review_state_check",
      sql`(${table.status} = 'pending' AND ${table.reviewedAt} IS NULL AND ${table.reviewedBy} IS NULL) OR (${table.status} IN ('approved', 'rejected') AND ${table.reviewedAt} IS NOT NULL)`,
    ),
    tableOwnerAccess("organization_sso_pending_member"),
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
    createdAt: timestamptz("created_at").notNull(),
    expiresAt: timestamptz("expires_at"),
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
    lastRefillAt: timestamptz("last_refill_at"),
    enabled: boolean("enabled").default(true).notNull(),
    rateLimitEnabled: boolean("rate_limit_enabled").default(true).notNull(),
    rateLimitTimeWindow: integer("rate_limit_time_window"),
    rateLimitMax: integer("rate_limit_max"),
    requestCount: integer("request_count").default(0).notNull(),
    remaining: integer("remaining"),
    lastRequest: timestamptz("last_request"),
    expiresAt: timestamptz("expires_at"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
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
    index("apikey_personal_owner_keyset_idx")
      .on(
        sql`((${table.metadata}::jsonb ->> 'organizationId'))`,
        table.referenceId,
        sql`${table.createdAt} DESC`,
        sql`${table.id} DESC`,
      )
      .where(
        sql`${table.metadata} IS NOT NULL AND ${table.metadata}::jsonb ->> 'kind' = 'personal'`,
      ),
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

export const OAUTH_CLIENT_REGISTRATION_ORIGINS = [
  "historical",
  "managed",
  "open-client",
  "agent",
] as const;

export const oauthClient = pgTable(
  "oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: text("client_discovery_id"),
    // When this discovery-owned client's metadata document last passed a
    // fetch and validation. It bounds how long the stored client keeps
    // resolving while the document cannot be revalidated.
    metadataValidatedAt: timestamptz("metadata_validated_at"),
    registrationOrigin: text("registration_origin", {
      enum: OAUTH_CLIENT_REGISTRATION_ORIGINS,
    })
      .notNull()
      .default("open-client"),
    disabled: boolean("disabled").default(false).notNull(),
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    subjectType: text("subject_type"),
    scopes: text("scopes").array(),
    clientCredentialsScopes: text("client_credentials_scopes")
      .array()
      .default([])
      .notNull(),
    userId: text("user_id").references(() => user.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
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
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: boolean(
      "backchannel_logout_session_required",
    ),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: text("grant_types").array(),
    responseTypes: text("response_types").array(),
    public: boolean("public"),
    type: text("type"),
    requirePKCE: boolean("require_pkce"),
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens")
      .default(false)
      .notNull(),
    referenceId: text("reference_id"),
    metadata: jsonb("metadata"),
  },
  (table) => [
    uniqueIndex("oauth_client_client_id_uidx").on(table.clientId),
    index("oauth_client_user_id_idx").on(table.userId),
    index("oauth_client_registration_retention_idx")
      .on(table.updatedAt, table.clientId)
      .where(
        sql`registration_origin IN ('historical', 'open-client', 'agent')`,
      ),
    check(
      "oauth_client_registration_origin_check",
      sql`${table.registrationOrigin} IN (${sql.join(
        OAUTH_CLIENT_REGISTRATION_ORIGINS.map((origin) =>
          sql.raw(`'${origin}'`),
        ),
        sql`, `,
      )})`,
    ),
    index("oauth_client_reference_id_idx").on(table.referenceId),
    ...denyStellaAccessPolicies(),
  ],
);

export const oauthResource = pgTable(
  "oauth_resource",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull().unique(),
    name: text("name").notNull(),
    accessTokenTtl: integer("access_token_ttl"),
    refreshTokenTtl: integer("refresh_token_ttl"),
    signingAlgorithm: text("signing_algorithm"),
    signingKeyId: text("signing_key_id"),
    allowedScopes: text("allowed_scopes").array(),
    customClaims: jsonb("custom_claims"),
    dpopBoundAccessTokensRequired: boolean("dpop_bound_access_tokens_required")
      .default(false)
      .notNull(),
    disabled: boolean("disabled").default(false).notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    policyVersion: integer("policy_version").default(1).notNull(),
    metadata: jsonb("metadata"),
  },
  () => [...denyStellaAccessPolicies()],
);

export const oauthClientResource = pgTable(
  "oauth_client_resource",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: jsonb("metadata"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("oauth_client_resource_client_id_resource_id_unique").on(
      table.clientId,
      table.resourceId,
    ),
    index("oauth_client_resource_client_id_idx").on(table.clientId),
    index("oauth_client_resource_resource_id_idx").on(table.resourceId),
    ...denyStellaAccessPolicies(),
  ],
);

export const oauthClientAssertion = pgTable(
  "oauth_client_assertion",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamptz("expires_at").notNull(),
  },
  (table) => [
    index("oauth_client_assertion_expires_at_idx").on(table.expiresAt),
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
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    revoked: timestamptz("revoked"),
    rotatedAt: timestamptz("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: timestamptz("rotation_replay_expires_at"),
    authTime: timestamptz("auth_time"),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (table) => [
    index("oauth_refresh_token_client_id_idx").on(table.clientId),
    index("oauth_refresh_token_session_id_idx").on(table.sessionId),
    index("oauth_refresh_token_user_id_idx").on(table.userId),
    index("oauth_refresh_token_reference_id_idx").on(table.referenceId),
    index("oauth_refresh_token_authorization_code_id_idx").on(
      table.authorizationCodeId,
    ),
    // Rotation revokes the old token in the same write; only its replay
    // window, and the response stored for it, outlive that.
    check(
      "oauth_refresh_token_rotation_revokes_check",
      sql`${table.rotatedAt} IS NULL OR ${table.revoked} IS NOT NULL`,
    ),
    check(
      "oauth_refresh_token_replay_window_check",
      sql`${table.rotationReplayExpiresAt} IS NULL OR ${table.rotatedAt} IS NOT NULL`,
    ),
    check(
      "oauth_refresh_token_replay_response_check",
      sql`${table.rotationReplayResponse} IS NULL OR ${table.rotationReplayExpiresAt} IS NOT NULL`,
    ),
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
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    revoked: timestamptz("revoked"),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (table) => [
    index("oauth_access_token_client_id_idx").on(table.clientId),
    index("oauth_access_token_session_id_idx").on(table.sessionId),
    index("oauth_access_token_user_id_idx").on(table.userId),
    index("oauth_access_token_reference_id_idx").on(table.referenceId),
    index("oauth_access_token_refresh_id_idx").on(table.refreshId),
    index("oauth_access_token_authorization_code_id_idx").on(
      table.authorizationCodeId,
    ),
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
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    scopes: text("scopes").array().notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
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

/**
 * Better Auth `@better-auth/scim` managed provisioning connections, credentials,
 * events, bindings, users, groups, and projection grants.
 */
export const scimManagedConnection = pgTable(
  "scim_managed_connection",
  {
    id: text("id").primaryKey(),
    creationRequestId: text("creation_request_id").notNull(),
    connectionId: text("connection_id").notNull(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    status: text("status").notNull(),
    revision: integer("revision").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    createdBy: text("created_by").notNull(),
    decommissionStartedAt: timestamptz("decommission_started_at"),
    decommissionStartedBy: text("decommission_started_by"),
    decommissionedAt: timestamptz("decommissioned_at"),
    decommissionedBy: text("decommissioned_by"),
  },
  (table) => [
    uniqueIndex("scim_managed_conn_creation_req_uidx").on(
      table.creationRequestId,
    ),
    uniqueIndex("scim_managed_conn_connection_id_uidx").on(table.connectionId),
    index("scim_managed_conn_domain_idx").on(table.provisioningDomainId),
    ...denyStellaAccessPolicies(),
  ],
);

export const scimManagedCredential = pgTable(
  "scim_managed_credential",
  {
    id: text("id").primaryKey(),
    connectionRecordId: text("connection_record_id")
      .notNull()
      .references(() => scimManagedConnection.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull(),
    tokenDigest: text("token_digest").notNull(),
    hashVersion: text("hash_version").notNull(),
    activeSlotKey: text("active_slot_key").notNull(),
    status: text("status").notNull(),
    serializedScopes: text("serialized_scopes").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    createdBy: text("created_by").notNull(),
    lastUsedAt: timestamptz("last_used_at"),
    revokedAt: timestamptz("revoked_at"),
    revokedBy: text("revoked_by"),
    decommissionedAt: timestamptz("decommissioned_at"),
  },
  (table) => [
    index("scim_managed_cred_conn_rec_idx").on(table.connectionRecordId),
    uniqueIndex("scim_managed_cred_id_uidx").on(table.credentialId),
    uniqueIndex("scim_managed_cred_active_slot_uidx").on(table.activeSlotKey),
    ...denyStellaAccessPolicies(),
  ],
);

export const scimManagedConnectionEvent = pgTable(
  "scim_managed_connection_event",
  {
    id: text("id").primaryKey(),
    connectionRecordId: text("connection_record_id")
      .notNull()
      .references(() => scimManagedConnection.id, { onDelete: "cascade" }),
    eventKey: text("event_key").notNull(),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    actorId: text("actor_id").notNull(),
    credentialId: text("credential_id"),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    index("scim_managed_evt_conn_rec_idx").on(table.connectionRecordId),
    uniqueIndex("scim_managed_evt_key_uidx").on(table.eventKey),
    ...denyStellaAccessPolicies(),
  ],
);

export const scimConnectionBinding = pgTable(
  "scim_connection_binding",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    connectionKey: text("connection_key").notNull(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    decommissionedAt: timestamptz("decommissioned_at"),
    decommissionStatus: text("decommission_status").default("active").notNull(),
    decommissionCursorUserId: text("decommission_cursor_user_id"),
    decommissionReconciledUserCount: integer(
      "decommission_reconciled_user_count",
    )
      .default(0)
      .notNull(),
    decommissionBatchCount: integer("decommission_batch_count")
      .default(0)
      .notNull(),
    decommissionRevision: integer("decommission_revision").default(0).notNull(),
    decommissionCompletedAt: timestamptz("decommission_completed_at"),
    decommissionLeaseId: text("decommission_lease_id"),
    decommissionLeaseExpiresAt: timestamptz("decommission_lease_expires_at"),
  },
  (table) => [
    index("scim_conn_binding_conn_id_idx").on(table.connectionId),
    uniqueIndex("scim_conn_binding_conn_key_uidx").on(table.connectionKey),
    ...denyStellaAccessPolicies(),
  ],
);

export const scimIdentityTombstone = pgTable(
  "scim_identity_tombstone",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    externalId: text("external_id").notNull(),
    externalIdKey: text("external_id_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    profile: text("profile").notNull(),
    deletedAt: timestamptz("deleted_at").notNull(),
  },
  (table) => [
    index("scim_tombstone_conn_id_idx").on(table.connectionId),
    index("scim_tombstone_domain_idx").on(table.provisioningDomainId),
    uniqueIndex("scim_tombstone_ext_id_key_uidx").on(table.externalIdKey),
    index("scim_tombstone_user_id_idx").on(table.userId),
    ...denyStellaAccessPolicies(),
  ],
);

export const scimSubject = pgTable(
  "scim_subject",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    profileSourceId: text("profile_source_id"),
    revision: integer("revision").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("scim_subject_user_id_uidx").on(table.userId),
    index("scim_subject_profile_source_idx").on(table.profileSourceId),
    ...denyStellaAccessPolicies(),
  ],
);

export const scimUser = pgTable(
  "scim_user",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    connectionUserKey: text("connection_user_key").notNull(),
    userName: text("user_name").notNull(),
    userNameKey: text("user_name_key").notNull(),
    primaryEmail: text("primary_email").notNull(),
    workEmailValueIndex: text("work_email_value_index").notNull(),
    emailValueIndex: text("email_value_index").notNull(),
    displayName: text("display_name").notNull(),
    formattedName: text("formatted_name").notNull(),
    givenName: text("given_name"),
    familyName: text("family_name"),
    serializedEmails: text("serialized_emails").notNull(),
    serializedAttributes: text("serialized_attributes"),
    externalId: text("external_id"),
    externalIdKey: text("external_id_key"),
    active: boolean("active").notNull(),
    orderKey: text("order_key").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    index("scim_user_conn_id_idx").on(table.connectionId),
    index("scim_user_domain_idx").on(table.provisioningDomainId),
    index("scim_user_user_id_idx").on(table.userId),
    uniqueIndex("scim_user_conn_user_key_uidx").on(table.connectionUserKey),
    uniqueIndex("scim_user_username_key_uidx").on(table.userNameKey),
    uniqueIndex("scim_user_ext_id_key_uidx").on(table.externalIdKey),
    uniqueIndex("scim_user_order_key_uidx").on(table.orderKey),
    ...denyStellaAccessPolicies(),
  ],
);

export const scimProjectionGrant = pgTable(
  "scim_projection_grant",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    scimUserId: text("scim_user_id")
      .notNull()
      .references(() => scimUser.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    sourceValue: text("source_value"),
    role: text("role").notNull(),
    grantKey: text("grant_key").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    index("scim_proj_grant_conn_id_idx").on(table.connectionId),
    index("scim_proj_grant_domain_idx").on(table.provisioningDomainId),
    index("scim_proj_grant_scim_user_idx").on(table.scimUserId),
    index("scim_proj_grant_user_id_idx").on(table.userId),
    uniqueIndex("scim_proj_grant_key_uidx").on(table.grantKey),
    ...denyStellaAccessPolicies(),
  ],
);

export const scimGroup = pgTable(
  "scim_group",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    revision: integer("revision").default(0).notNull(),
    displayName: text("display_name").notNull(),
    displayNameKey: text("display_name_key").notNull(),
    externalId: text("external_id"),
    externalIdKey: text("external_id_key"),
    orderKey: text("order_key").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    index("scim_group_conn_id_idx").on(table.connectionId),
    index("scim_group_domain_idx").on(table.provisioningDomainId),
    uniqueIndex("scim_group_display_name_key_uidx").on(table.displayNameKey),
    uniqueIndex("scim_group_ext_id_key_uidx").on(table.externalIdKey),
    uniqueIndex("scim_group_order_key_uidx").on(table.orderKey),
    ...denyStellaAccessPolicies(),
  ],
);

export const scimGroupMember = pgTable(
  "scim_group_member",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    groupId: text("group_id")
      .notNull()
      .references(() => scimGroup.id, { onDelete: "cascade" }),
    scimUserId: text("scim_user_id")
      .notNull()
      .references(() => scimUser.id, { onDelete: "cascade" }),
    membershipKey: text("membership_key").notNull(),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    index("scim_group_member_conn_id_idx").on(table.connectionId),
    index("scim_group_member_group_id_idx").on(table.groupId),
    index("scim_group_member_scim_user_idx").on(table.scimUserId),
    uniqueIndex("scim_group_member_key_uidx").on(table.membershipKey),
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
  ssoProvider,
  scimManagedConnection,
  scimManagedCredential,
  scimManagedConnectionEvent,
  scimConnectionBinding,
  scimIdentityTombstone,
  scimSubject,
  scimUser,
  scimProjectionGrant,
  scimGroup,
  scimGroupMember,
  jwks,
  apikey,
  oauthClient,
  oauthResource,
  oauthClientResource,
  oauthClientAssertion,
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
  oauthResource: {
    clients: r.many.oauthClientResource({
      from: r.oauthResource.identifier,
      to: r.oauthClientResource.resourceId,
    }),
  },
  oauthClientResource: {
    client: r.one.oauthClient({
      from: r.oauthClientResource.clientId,
      to: r.oauthClient.clientId,
    }),
    resource: r.one.oauthResource({
      from: r.oauthClientResource.resourceId,
      to: r.oauthResource.identifier,
    }),
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
    ssoProviders: r.many.ssoProvider({
      from: r.organization.id,
      to: r.ssoProvider.organizationId,
    }),
  },
  ssoProvider: {
    organization: r.one.organization({
      from: r.ssoProvider.organizationId,
      to: r.organization.id,
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
    resources: r.many.oauthClientResource({
      from: r.oauthClient.clientId,
      to: r.oauthClientResource.clientId,
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
