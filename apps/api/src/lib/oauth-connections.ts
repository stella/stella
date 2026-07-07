import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";

import { oauthClient, oauthConsent, organization } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { revokeOAuthClientAuthArtifacts } from "@/api/lib/auth-artifacts";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

/**
 * Per /conventions-security ("Handlers must not import the root db
 * module"): `oauth_consent`, `oauth_client`, `oauth_access_token`, and
 * `oauth_refresh_token` all deny RLS-scoped access entirely (see
 * `denyStellaAccessPolicies` in `db/rls.ts`), so every query here runs on
 * `rootDb` and manually scopes to the caller's `userId`. Handlers only ever
 * reach this module through the narrow helpers below, never `rootDb`
 * directly.
 */

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
export const disconnectOAuthConnectionForUser = async (
  userId: SafeId<"user">,
  consentId: string,
): Promise<Result<DisconnectedOAuthConnection | null, HandlerError>> =>
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

        return { id: consent.id };
      }),
    catch: (err) =>
      new HandlerError({
        status: 500,
        message: "Database operation failed",
        cause: err,
      }),
  });
