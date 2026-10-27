import type { OAuthClaimExtensionInput } from "@better-auth/oauth-provider";
import { and, eq } from "drizzle-orm";

import { oauthConsent } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";

export const OAUTH_GRANT_ID_CLAIM = "stella_grant_id";

/** Pins a signed user access token to the consent row that authorized it. */
export const getOAuthGrantIdentityClaims = async ({
  client,
  user,
  referenceId,
}: OAuthClaimExtensionInput) => {
  if (!user || !referenceId) {
    return {};
  }

  const grant = await rootDb
    .select({ id: oauthConsent.id })
    .from(oauthConsent)
    .where(
      and(
        eq(oauthConsent.clientId, client.clientId),
        eq(oauthConsent.userId, user.id),
        eq(oauthConsent.referenceId, referenceId),
      ),
    )
    .limit(1)
    .then((rows) => rows.at(0));

  return grant ? { [OAUTH_GRANT_ID_CLAIM]: grant.id } : {};
};
