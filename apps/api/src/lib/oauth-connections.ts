import { Result } from "better-result";
import { and, desc, eq, sql } from "drizzle-orm";

import { oauthClient, oauthConsent, organization } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { oauthGrantRevocations } from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import { revokeOAuthClientAuthArtifacts } from "@/api/lib/auth-artifacts";
import { ACCESS_TOKEN_EXPIRES_IN_SECONDS } from "@/api/lib/auth/access-token-lifetime";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";

/**
 * Per /conventions-security ("Handlers must not import the root db
 * module"): `oauth_consent`, `oauth_client`, `oauth_access_token`, and
 * `oauth_refresh_token` all deny RLS-scoped access entirely (see
 * `denyStellaAccessPolicies` in `db/rls.ts`), so every query here runs on
 * `rootDb` and manually scopes to the caller's `userId`. Handlers only ever
 * reach this module through the narrow helpers below, never `rootDb`
 * directly.
 */

type FindOAuthGrantIdentityOptions = {
  clientId: string;
  userId: string;
  referenceId: string;
};

/** Resolves the consent identity bound to the provider's user and organization. */
export const findOAuthGrantIdentity = async ({
  clientId,
  userId,
  referenceId,
}: FindOAuthGrantIdentityOptions) =>
  await rootDb
    .select({ id: oauthConsent.id })
    .from(oauthConsent)
    .where(
      and(
        eq(oauthConsent.clientId, clientId),
        eq(oauthConsent.userId, userId),
        eq(oauthConsent.referenceId, referenceId),
      ),
    )
    .limit(1)
    .then((rows) => rows.at(0));

export type OAuthConnectionSummary = {
  id: string;
  clientId: string;
  clientName: string | null;
  clientIcon: string | null;
  clientUri: string | null;
  scopes: string[];
  createdAt: Date;
  referenceId: string | null;
  organizationName: string | null;
};

/**
 * Lists the session user's authorized OAuth clients ("connected apps") in
 * one round-trip: joins `oauth_consent` with `oauth_client` for display
 * data and left-joins `organization` to resolve `referenceId` (the
 * organization a grant is scoped to, when present) to a name.
 */
export const listOAuthConnectionsForUser = async (
  userId: SafeId<"user">,
): Promise<Result<OAuthConnectionSummary[], HandlerError>> =>
  await Result.tryPromise({
    try: async () =>
      await rootDb
        .select({
          id: oauthConsent.id,
          clientId: oauthConsent.clientId,
          clientName: oauthClient.name,
          clientIcon: oauthClient.icon,
          clientUri: oauthClient.uri,
          scopes: oauthConsent.scopes,
          createdAt: oauthConsent.createdAt,
          referenceId: oauthConsent.referenceId,
          organizationName: organization.name,
        })
        .from(oauthConsent)
        .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
        .leftJoin(organization, eq(organization.id, oauthConsent.referenceId))
        .where(eq(oauthConsent.userId, userId))
        // Newest grants first so the cap always keeps the most recent
        // connections visible; exceeding it is pathological (every row
        // requires an explicit user consent), so no pagination envelope.
        .orderBy(desc(oauthConsent.createdAt))
        .limit(LIMITS.oauthConnectionsPageSizeMax),
    catch: (err) =>
      new HandlerError({
        status: 500,
        message: "Database query failed",
        cause: err,
      }),
  });

export type DisconnectedOAuthConnection = {
  id: string;
};

/**
 * Disconnects one OAuth grant. The better-auth `delete-consent` endpoint
 * only removes the consent row and leaves any issued refresh token valid
 * for up to 30 days, so this instead runs a single transaction that:
 *  1. deletes the `oauth_consent` row, scoped to `id` AND `userId` (a
 *     consent owned by another user is invisible, returns `null`);
 *  2. revokes every `oauth_access_token` and `oauth_refresh_token` issued
 *     to that client for that user, further scoped by `referenceId` when
 *     the consent had one (an org-scoped grant only revokes that org's
 *     tokens).
 *
 * Returns `null` when no matching consent exists for this user (the
 * handler turns that into a 404 without revealing whether the id belongs
 * to someone else).
 */
type DisconnectOAuthConnectionOptions = {
  consentId: string;
  request: Request;
  userId: SafeId<"user">;
};

export const disconnectOAuthConnectionForUser = async ({
  consentId,
  request,
  userId,
}: DisconnectOAuthConnectionOptions): Promise<
  Result<DisconnectedOAuthConnection | null, HandlerError>
> =>
  await Result.tryPromise({
    try: async () =>
      await rootDb.transaction(async (tx) => {
        const deletedConsents = await tx
          .delete(oauthConsent)
          .where(
            and(
              eq(oauthConsent.id, consentId),
              eq(oauthConsent.userId, userId),
            ),
          )
          .returning({
            clientId: oauthConsent.clientId,
            id: oauthConsent.id,
            referenceId: oauthConsent.referenceId,
          });

        const consent = deletedConsents.at(0);
        if (!consent) {
          return null;
        }

        await revokeOAuthClientAuthArtifacts(tx, {
          userId,
          clientId: consent.clientId,
          referenceId: consent.referenceId,
        });

        const revokedAt = new Date();
        await tx
          .delete(oauthGrantRevocations)
          .where(
            and(
              eq(oauthGrantRevocations.userId, userId),
              sql`${oauthGrantRevocations.revokedAt} < CURRENT_TIMESTAMP - ${ACCESS_TOKEN_EXPIRES_IN_SECONDS} * INTERVAL '1 second'`,
            ),
          );

        if (consent.referenceId) {
          await tx
            .insert(oauthGrantRevocations)
            .values({
              organizationId: consent.referenceId,
              userId,
              oauthClientId: consent.clientId,
              grantId: consent.id,
              revokedAt,
            })
            .onConflictDoNothing({
              target: [
                oauthGrantRevocations.organizationId,
                oauthGrantRevocations.userId,
                oauthGrantRevocations.oauthClientId,
                oauthGrantRevocations.grantId,
              ],
            });
          const recordAuditEvent = createAuditRecorder({
            organizationId: brandPersistedOrganizationId(consent.referenceId),
            request,
            server: null,
            userId,
            workspaceId: null,
          });
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.MCP_CONNECTION,
            resourceId: consent.clientId,
          });
        }

        return { id: consent.id };
      }),
    catch: (err) =>
      new HandlerError({
        status: 500,
        message: "Database operation failed",
        cause: err,
      }),
  });
