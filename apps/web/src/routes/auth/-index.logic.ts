import {
  getOauthHashFragment,
  getSignedOauthQueryFromHash,
  hasSignedOauthQuery,
} from "@/lib/oauth-provider";

/**
 * Where a signed-in visitor resumes an OAuth authorization request: the
 * organization step, carrying the signed query from the hash bridge or the
 * search string. Null when the URL carries no signed request.
 */
export const getOauthPostLoginRedirectTo = ({
  hash,
  searchStr,
}: {
  hash: string;
  searchStr: string;
}) => {
  const bridgedQuery = getSignedOauthQueryFromHash(hash);
  if (bridgedQuery) {
    return `/auth/organization#${getOauthHashFragment(bridgedQuery)}`;
  }

  if (!hasSignedOauthQuery(searchStr)) {
    return null;
  }

  return `/auth/organization${searchStr}`;
};
