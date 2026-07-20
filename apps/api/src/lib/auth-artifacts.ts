import { and, eq, isNull } from "drizzle-orm";
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
import type { SafeId } from "@/api/lib/branded-types";
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

type RevokeOrganizationMemberAuthArtifactsOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

export const revokeOrganizationMemberAuthArtifacts = async (
  tx: AuthArtifactTransaction,
  { organizationId, userId }: RevokeOrganizationMemberAuthArtifactsOptions,
): Promise<void> => {
  await tx
    .delete(oauthAccessToken)
    .where(
      and(
        eq(oauthAccessToken.userId, userId),
        eq(oauthAccessToken.referenceId, organizationId),
      ),
    );

  await tx
    .delete(oauthRefreshToken)
    .where(
      and(
        eq(oauthRefreshToken.userId, userId),
        eq(oauthRefreshToken.referenceId, organizationId),
      ),
    );

  // Org-scoped consent grants die with the membership: leaving them behind
  // would keep the organization listed on the ex-member's connected-apps
  // page and let a client silently re-mint tokens on the next authorize.
  await tx
    .delete(oauthConsent)
    .where(
      and(
        eq(oauthConsent.userId, userId),
        eq(oauthConsent.referenceId, organizationId),
      ),
    );

  await tx
    .delete(sessionTable)
    .where(
      and(
        eq(sessionTable.userId, userId),
        eq(sessionTable.activeOrganizationId, organizationId),
      ),
    );

  // auth.md agent registrations/delegations bound to this member in this org:
  // their access tokens are already gone above; drop the ceremony state and
  // the (iss,sub) delegation so a re-added member never inherits a stale link.
  await tx
    .delete(agentRegistration)
    .where(
      and(
        eq(agentRegistration.boundUserId, userId),
        eq(agentRegistration.boundOrganizationId, organizationId),
      ),
    );

  await tx
    .delete(agentDelegation)
    .where(
      and(
        eq(agentDelegation.userId, userId),
        eq(agentDelegation.organizationId, organizationId),
      ),
    );

  // Machine API keys the departing member holds *in this organization*.
  //
  // Without this the keys only stop working incidentally: `api-key-auth.ts`
  // resolves the owner's `member` row and rejects the credential when there is
  // none. Re-invite the same person and that row comes back, and with it every
  // machine key they ever minted here — an offboarding that silently undoes
  // itself, and a leaked key that revocation-by-removal never actually killed.
  //
  // Disabled, not deleted, matching `handlers/api-keys/revoke.ts`: the row
  // carries the audit trail and the `start` prefix an operator needs to match a
  // leaked credential back to the key that leaked, and a deleted row takes both
  // with it. `resolveMachineApiKeySession` checks `enabled` before it looks at
  // membership, so a disabled key stays dead across a re-invite. (Account
  // deletion is the one path that does delete these rows: there the owner is
  // gone entirely and there is no operator left to audit on behalf of.)
  //
  // The scope is both halves and must stay both halves: `referenceId` is the
  // owner (the plugin runs with `references: "user"`) and the metadata
  // predicate is the organization. A member of two organizations who leaves one
  // keeps working in the other, so narrowing to either half alone is wrong in a
  // different direction — owner-only would revoke keys in organizations they
  // are still a member of, organization-only would revoke their colleagues'.
  // The organization half is applied in SQL via the shared scope helper, never
  // post-filtered: `apikey` denies the scoped `stella` role, so these rows
  // arrive with no RLS behind them and the `WHERE` clause is the only tenant
  // boundary there is.
  await tx
    .update(apikey)
    .set({ enabled: false, updatedAt: new Date() })
    .where(
      and(
        eq(apikey.referenceId, userId),
        machineApiKeyOrganizationScope(organizationId),
        // Already-revoked rows are left alone so `updated_at` keeps pointing at
        // the revocation that actually happened.
        eq(apikey.enabled, true),
      ),
    );
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
