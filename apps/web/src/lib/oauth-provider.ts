import { buildApiUrl } from "@stll/api-contract";

const OAUTH_SIGNATURE_PARAM = "sig";
const OAUTH_QUERY_HASH_PARAM = "oauth_query";
const BETTER_AUTH_INTERNAL_QUERY_PARAMS = [
  OAUTH_SIGNATURE_PARAM,
  "exp",
  "ba_iat",
  "ba_pl",
  "ba_param",
] as const;

export const hasSignedOauthQuery = (search: string) => {
  const query = search.startsWith("?") ? search.slice(1) : search;
  if (query.length === 0) {
    return false;
  }

  return new URLSearchParams(query).has(OAUTH_SIGNATURE_PARAM);
};

export const getSignedOauthQueryFromHash = (hash: string): string | null => {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (fragment.length === 0) {
    return null;
  }

  const query = new URLSearchParams(fragment).get(OAUTH_QUERY_HASH_PARAM);
  if (!query || !hasSignedOauthQuery(query)) {
    return null;
  }

  return query;
};

/** Resolve a signed consent continuation from either supported transport. */
export const getSignedOauthQuery = ({
  hash,
  search,
}: {
  hash: string;
  search: string;
}): string | null => {
  const bridgedQuery = getSignedOauthQueryFromHash(hash);
  if (bridgedQuery !== null) {
    return bridgedQuery;
  }

  const query = search.startsWith("?") ? search.slice(1) : search;
  return hasSignedOauthQuery(query) ? query : null;
};

export const getOauthHashFragment = (query: string): string => {
  const fragment = new URLSearchParams();
  fragment.set(OAUTH_QUERY_HASH_PARAM, query);
  return fragment.toString();
};

export const getOauthClientDisplayName = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  if (
    "client_name" in value &&
    typeof value.client_name === "string" &&
    value.client_name.length > 0
  ) {
    return value.client_name;
  }

  if ("name" in value && typeof value.name === "string" && value.name.length) {
    return value.name;
  }

  return null;
};

export const getOauthRedirectUrl = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  if ("url" in value && typeof value.url === "string" && value.url.length > 0) {
    return value.url;
  }

  if (
    "redirect_uri" in value &&
    typeof value.redirect_uri === "string" &&
    value.redirect_uri.length > 0
  ) {
    return value.redirect_uri;
  }

  return null;
};

export const oauthClientAllowsScopes = (
  value: unknown,
  scopes: readonly string[],
): boolean => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("scope" in value) ||
    typeof value.scope !== "string"
  ) {
    return false;
  }

  const registeredScopes = new Set(value.scope.split(" ").filter(Boolean));
  return scopes.every((scope) => registeredScopes.has(scope));
};

/**
 * Restarts a Better Auth authorization request with a broader scope set.
 * Consent continuations are signed, so their scope cannot be edited in place:
 * copy the original OAuth parameters, remove Better Auth's continuation-only
 * signature metadata, and send a fresh request through the authorization
 * endpoint. The provider revalidates the client, redirect URI and PKCE before
 * showing the expanded consent screen.
 */
export const getExpandedOauthAuthorizationUrl = ({
  apiBaseUrl,
  oauthQuery,
  scopes,
}: {
  apiBaseUrl: string;
  oauthQuery: string;
  scopes: readonly string[];
}): string | null => {
  if (!hasSignedOauthQuery(oauthQuery)) {
    return null;
  }

  const params = new URLSearchParams(oauthQuery);
  for (const key of BETTER_AUTH_INTERNAL_QUERY_PARAMS) {
    params.delete(key);
  }

  const requiredParameters = [
    "client_id",
    "redirect_uri",
    "response_type",
  ] as const;
  if (requiredParameters.some((key) => !params.has(key))) {
    return null;
  }

  const expandedScopes = new Set(
    params.get("scope")?.split(" ").filter(Boolean),
  );
  for (const scope of scopes) {
    expandedScopes.add(scope);
  }
  params.set("scope", [...expandedScopes].join(" "));
  params.set("prompt", addConsentPrompt(params.get("prompt")));

  const url = new URL(buildApiUrl(apiBaseUrl, "/api/auth/oauth2/authorize"));
  url.search = params.toString();
  return url.toString();
};

const addConsentPrompt = (prompt: string | null): string => {
  const tokens = prompt ? prompt.split(" ").filter(Boolean) : [];
  const compatibleTokens = tokens.filter((token) => token !== "none");
  if (!compatibleTokens.includes("consent")) {
    compatibleTokens.push("consent");
  }
  return [...new Set(compatibleTokens)].join(" ");
};
