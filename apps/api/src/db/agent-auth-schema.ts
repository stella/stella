import { defineRelationsPart, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { denyStellaAccessPolicies } from "@/api/db/rls";

/**
 * Agent-registration ceremony state for the auth.md protocol.
 *
 * This is control-plane auth data on the same trust tier as
 * `oauth_client`: it carries hashed claim tokens and the better-auth
 * authorization code an agent will exchange for a scoped access token.
 * The scoped `stella` role is denied all access
 * (`denyStellaAccessPolicies`); every read/write goes through the
 * table-owner `rootDb`.
 */
export const agentRegistration = pgTable(
  "agent_registration",
  {
    id: text("id").primaryKey(),
    registrationType: text("registration_type").notNull(),
    status: text("status").notNull().default("pending"),
    userCode: text("user_code"),
    /** SHA-256 of the bearer claim token; never store the raw token. */
    claimTokenHash: text("claim_token_hash").notNull(),
    clientId: text("client_id").notNull(),
    /**
     * Raw secret of the first-party agent OAuth client. better-auth
     * stores only the hash on `oauth_client`, but the server-side code
     * exchange needs the cleartext secret. Held on this deny-stella
     * control-plane row (same trust tier as `oauth_client`); never
     * returned to any caller.
     */
    clientSecretSink: text("client_secret_sink").notNull(),
    loginHint: text("login_hint"),
    boundUserId: text("bound_user_id"),
    boundOrganizationId: text("bound_organization_id"),
    /**
     * For an ID-JAG first-link step-up: the `(iss, sub)` whose delegation
     * must be written once the human confirms this ceremony. Null for
     * service_auth / anonymous registrations, which establish no
     * cross-issuer delegation.
     */
    pendingDelegationIss: text("pending_delegation_iss"),
    pendingDelegationSub: text("pending_delegation_sub"),
    grantedScopes: text("granted_scopes").array().notNull().default([]),
    /** better-auth authorization code to exchange at /oauth2/token. */
    authorizationCode: text("authorization_code"),
    pollIntervalSeconds: integer("poll_interval_seconds").notNull().default(5),
    expiresAt: timestamp("expires_at").notNull(),
    lastPolledAt: timestamp("last_polled_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("agent_registration_claim_token_hash_uidx").on(
      table.claimTokenHash,
    ),
    // A `user_code` is only meaningful while a registration awaits a
    // human claim. Scoping uniqueness to live `pending` rows lets a code
    // be reused after a ceremony resolves without colliding on history.
    uniqueIndex("agent_registration_pending_user_code_uidx")
      .on(table.userCode)
      .where(sql`status = 'pending' AND user_code IS NOT NULL`),
    index("agent_registration_status_idx").on(table.status),
    index("agent_registration_bound_user_id_idx").on(table.boundUserId),
    ...denyStellaAccessPolicies(),
  ],
);

/**
 * Operator-managed allow-list of identity providers whose ID-JAG
 * assertions Stella will accept. Ships with ZERO rows, so the
 * identity_assertion path accepts nothing until an operator explicitly
 * trusts an issuer (config/DB only; no issuer is hardcoded in source).
 * Same control-plane trust tier as `oauth_client`: deny-stella, rootDb
 * only.
 */
export const agentTrustedIssuer = pgTable(
  "agent_trusted_issuer",
  {
    issuer: text("issuer").primaryKey(),
    displayName: text("display_name").notNull(),
    /**
     * Optional per-issuer attestation policy enforced during validation
     * (e.g. `{ requiredAmr: ["mfa"] }`). Null means no extra constraint
     * beyond the baseline ID-JAG claim checks.
     */
    attestationPolicy: jsonb("attestation_policy"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  () => [...denyStellaAccessPolicies()],
);

/**
 * Durable `(iss, sub)` -> Stella user/org binding established the first
 * time a trusted issuer vouches for an identity. Its existence is the
 * strongest account match: it lets a return assertion route straight to
 * the bound principal without re-running the human step-up. An external
 * platform can never silently take over an existing account: a binding
 * is written only on auto-provision (brand-new identity) or after the
 * human completes the first-link claim ceremony.
 */
export const agentDelegation = pgTable(
  "agent_delegation",
  {
    id: text("id").primaryKey(),
    iss: text("iss").notNull(),
    sub: text("sub").notNull(),
    userId: text("user_id").notNull(),
    organizationId: text("organization_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("agent_delegation_iss_sub_uidx").on(table.iss, table.sub),
    index("agent_delegation_user_id_idx").on(table.userId),
    ...denyStellaAccessPolicies(),
  ],
);

/**
 * One-time-use store of accepted ID-JAG `jti` values: a presented `jti`
 * already here is a replay and is rejected. `expiresAt` mirrors the
 * assertion `exp` so rows can be pruned once they can no longer be
 * replayed. Deny-stella control-plane data; rootDb only.
 */
export const agentAssertionReplay = pgTable(
  "agent_assertion_replay",
  {
    jti: text("jti").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("agent_assertion_replay_expires_at_idx").on(table.expiresAt),
    ...denyStellaAccessPolicies(),
  ],
);

export const agentAuthSchema = {
  agentRegistration,
  agentTrustedIssuer,
  agentDelegation,
  agentAssertionReplay,
};

export const agentAuthRelationsPart = defineRelationsPart(
  agentAuthSchema,
  () => ({}),
);
