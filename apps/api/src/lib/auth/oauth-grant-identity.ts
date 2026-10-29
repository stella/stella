import type { OAuthClaimExtensionInput } from "@better-auth/oauth-provider";

import { findOAuthGrantIdentity } from "@/api/lib/oauth-connections";

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

  const grant = await findOAuthGrantIdentity({
    clientId: client.clientId,
    userId: user.id,
    referenceId,
  });

  return grant ? { [OAUTH_GRANT_ID_CLAIM]: grant.id } : {};
};
