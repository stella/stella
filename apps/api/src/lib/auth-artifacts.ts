import { and, eq, isNull, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";

import { agentDelegation, agentRegistration } from "@/api/db/agent-auth-schema";
import {
  apikey,
  oauthAccessToken,
  oauthConsent,
  oauthRefreshToken,
  session as sessionTable,
} from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ApiKeyConfigId } from "@/api/lib/api-key-plugin-configs";
import type { SafeId } from "@/api/lib/branded-types";
import { DESKTOP_REGISTRY_KEY_CONFIG } from "@/api/lib/business-registries/desktop/config";
import { desktopRegistryKeyOrganizationScope } from "@/api/lib/business-registries/desktop/scope";
import { MACHINE_API_KEY_CONFIG_ID } from "@/api/lib/machine-api-key-config";
import { machineApiKeyOrganizationScope } from "@/api/lib/machine-api-key-scope";

/** A statement that is awaited for its effect; no caller here reads the rows. */
type ExecutableWhereStep = {
  where: (condition: SQL | undefined) => PromiseLike<unknown>;
};

/**
 * The transaction shape this module needs, stated as a structural constraint
 * over the driver rather than as the production `Transaction` alias.
 *
 * Drizzle threads the driver's query-result type through every builder, so the
 * Bun SQL transaction production runs on and the PGlite transaction the
 * security tests run on are not assignable to one another, even though every
 * statement below is identical for both. Nothing here reads a query result, so
 * the driver genuinely is irrelevant; saying that in the type is what lets
 * these revocations be tested against real SQL instead of a mocked transaction,
 * which for a tenant-scoping predicate is the only test worth having.
 *
 * This is a constraint, not an escape hatch: the table and the `.set()` payload
 * stay fully typed, so a column typo or a wrong-table filter still fails to
 * compile.
 */
type AuthArtifactTransaction = {
  delete: (table: PgTable) => ExecutableWhereStep;
  update: <TTable extends PgTable>(
    table: TTable,
  ) => { set: (values: PgUpdateSetSource<TTable>) => ExecutableWhereStep };
};

type MemberCredentialScope = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

type RevokeMemberCredentials = (
  tx: AuthArtifactTransaction,
  scope: MemberCredentialScope,
) => Promise<void>;

/**
 * Which of a user's API keys belong to one organization, for every
 * configuration registered on the API key plugin. Total over the registered
 * configurations, so registering a new one does not compile until member
 * removal knows how to find that configuration's keys.
 *
 * Each predicate is its configuration's single tenant scope, shared with that
 * configuration's own revocation path: `apikey` denies the scoped `stella`
 * role, so these rows arrive with no RLS behind them and the `WHERE` clause is
 * the only tenant boundary there is.
 */
const API_KEY_ORGANIZATION_SCOPE = {
  [DESKTOP_REGISTRY_KEY_CONFIG]: desktopRegistryKeyOrganizationScope,
  [MACHINE_API_KEY_CONFIG_ID]: machineApiKeyOrganizationScope,
} as const satisfies Record<
  ApiKeyConfigId,
  (organizationId: SafeId<"organization">) => SQL | undefined
>;

/**
 * Every kind of credential a member can hold in an organization, and how
 * leaving that organization ends it. Membership removal runs all of them in
 * one transaction; none may rely on a verifier re-checking membership later,
 * because re-inviting the same person restores exactly that membership.
 */
const MEMBER_CREDENTIAL_REVOCATION = {
  oauthAccessToken: async (
    tx,
    { organizationId, userId }: MemberCredentialScope,
  ) => {
    await tx
      .delete(oauthAccessToken)
      .where(
        and(
          eq(oauthAccessToken.userId, userId),
          eq(oauthAccessToken.referenceId, organizationId),
        ),
      );
  },
  oauthRefreshToken: async (
    tx,
    { organizationId, userId }: MemberCredentialScope,
  ) => {
    await tx
      .delete(oauthRefreshToken)
      .where(
        and(
          eq(oauthRefreshToken.userId, userId),
          eq(oauthRefreshToken.referenceId, organizationId),
        ),
      );
  },
  // Org-scoped consent grants end with the membership: leaving them behind
  // would keep the organization listed on the former member's connected-apps
  // page and let a client silently re-mint tokens on the next authorize.
  oauthConsent: async (
    tx,
    { organizationId, userId }: MemberCredentialScope,
  ) => {
    await tx
      .delete(oauthConsent)
      .where(
        and(
          eq(oauthConsent.userId, userId),
          eq(oauthConsent.referenceId, organizationId),
        ),
      );
  },
  // Deleting the session also ends every JWT access token minted under it:
  // the provider's introspection treats a token whose `sid` is gone as
  // inactive.
  session: async (tx, { organizationId, userId }: MemberCredentialScope) => {
    await tx
      .delete(sessionTable)
      .where(
        and(
          eq(sessionTable.userId, userId),
          eq(sessionTable.activeOrganizationId, organizationId),
        ),
      );
  },
  // auth.md agent registrations and delegations bound to this member in this
  // org: their access tokens are already gone above; drop the ceremony state
  // and the (iss,sub) delegation so a re-added member starts without a link.
  agentRegistration: async (
    tx,
    { organizationId, userId }: MemberCredentialScope,
  ) => {
    await tx
      .delete(agentRegistration)
      .where(
        and(
          eq(agentRegistration.boundUserId, userId),
          eq(agentRegistration.boundOrganizationId, organizationId),
        ),
      );
  },
  agentDelegation: async (
    tx,
    { organizationId, userId }: MemberCredentialScope,
  ) => {
    await tx
      .delete(agentDelegation)
      .where(
        and(
          eq(agentDelegation.userId, userId),
          eq(agentDelegation.organizationId, organizationId),
        ),
      );
  },
  // API keys the departing member holds *in this organization*, under every
  // registered configuration.
  //
  // Disabled, not deleted, matching `handlers/api-keys/revoke.ts`: the row
  // carries the audit trail and the `start` prefix an operator needs to match
  // an exposed credential back to its key, and a deleted row takes both with
  // it. Every key verifier checks `enabled` before it looks at membership, so
  // a disabled key stays disabled across a re-invite. (Account deletion is the
  // one path that does delete these rows: there the owner is gone entirely.)
  //
  // The scope is both halves and must stay both halves: `referenceId` is the
  // owner (every configuration runs with `references: "user"`) and the
  // configuration's predicate is the organization. A member of two
  // organizations who leaves one keeps working in the other, so owner-only
  // would revoke keys in organizations they still belong to, and
  // organization-only would revoke their colleagues'.
  apiKey: async (tx, { organizationId, userId }: MemberCredentialScope) => {
    const organizationScopes = Object.values(API_KEY_ORGANIZATION_SCOPE).map(
      (scope) => scope(organizationId),
    );
    await tx
      .update(apikey)
      .set({ enabled: false, updatedAt: new Date() })
      .where(
        and(
          eq(apikey.referenceId, userId),
          or(...organizationScopes),
          // Already-revoked rows are left alone so `updated_at` keeps pointing
          // at the revocation that actually happened.
          eq(apikey.enabled, true),
        ),
      );
  },
} as const satisfies Record<string, RevokeMemberCredentials>;

/**
 * End every credential one member holds in one organization. Runs inside the
 * caller's transaction so the membership row and its credentials go together.
 */
export const revokeOrganizationMemberAuthArtifacts = async (
  tx: AuthArtifactTransaction,
  scope: MemberCredentialScope,
): Promise<void> => {
  for (const revoke of Object.values(MEMBER_CREDENTIAL_REVOCATION)) {
    await revoke(tx, scope);
  }
};

type RevokeOAuthClientAuthArtifactsOptions = {
  userId: SafeId<"user">;
  clientId: string;
  /**
   * The consent's organization scope. Token revocation matches it exactly:
   * an org-scoped grant only revokes that organization's tokens, and a
   * `null` (org-unscoped) grant only revokes tokens that carry no
   * organization, so sibling grants of the same client stay intact.
   */
  referenceId: string | null;
};

/**
 * Revokes every OAuth token one client holds for one user under one grant
 * (per-consent disconnect from the connections settings page). Unlike
 * `revokeOrganizationMemberAuthArtifacts` this must NOT touch `session`
 * rows: disconnecting an OAuth app ends that app's access, not the
 * user's own web sessions.
 *
 * Access tokens are verified statelessly (JWT via JWKS), so an already
 * issued token keeps working until its expiry (15 minutes, see
 * `ACCESS_TOKEN_EXPIRES_IN`); deleting the refresh token guarantees it
 * cannot be renewed. Checking the DB on every MCP request to close that
 * window was deliberately rejected as a hot-path cost.
 */
export const revokeOAuthClientAuthArtifacts = async (
  tx: Transaction,
  { userId, clientId, referenceId }: RevokeOAuthClientAuthArtifactsOptions,
): Promise<void> => {
  await tx
    .delete(oauthAccessToken)
    .where(
      and(
        eq(oauthAccessToken.userId, userId),
        eq(oauthAccessToken.clientId, clientId),
        referenceId
          ? eq(oauthAccessToken.referenceId, referenceId)
          : isNull(oauthAccessToken.referenceId),
      ),
    );

  await tx
    .delete(oauthRefreshToken)
    .where(
      and(
        eq(oauthRefreshToken.userId, userId),
        eq(oauthRefreshToken.clientId, clientId),
        referenceId
          ? eq(oauthRefreshToken.referenceId, referenceId)
          : isNull(oauthRefreshToken.referenceId),
      ),
    );
};

/**
 * Ends every web session a user holds, across all organizations. Account
 * deletion only: the user row is soft-deleted, so the `session` cascade on
 * `user` never fires and the rows have to go explicitly.
 */
export const revokeAllUserSessions = async (
  tx: AuthArtifactTransaction,
  userId: SafeId<"user">,
): Promise<void> => {
  await tx.delete(sessionTable).where(eq(sessionTable.userId, userId));
};

/**
 * Revokes every OAuth access and refresh token a user holds, across all
 * clients and organizations. Account deletion only; per-grant and
 * per-membership revocation stay on the scoped helpers above.
 */
export const revokeAllUserOAuthTokens = async (
  tx: AuthArtifactTransaction,
  userId: SafeId<"user">,
): Promise<void> => {
  await tx.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, userId));
  await tx
    .delete(oauthRefreshToken)
    .where(eq(oauthRefreshToken.userId, userId));
};
