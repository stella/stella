import * as v from "valibot";

import { VERIFIED_OAUTH_CLIENT_BRANDS } from "@stll/api-contract";

const OAUTH_SIGNATURE_PARAM = "sig";
const OAUTH_QUERY_HASH_PARAM = "oauth_query";

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

/** The signed OAuth request a page received, from the hash bridge or its query. */
export const getSignedOauthQuery = ({
  hash,
  searchStr,
}: {
  hash: string;
  searchStr: string;
}): string | null => {
  const bridgedQuery = getSignedOauthQueryFromHash(hash);
  if (bridgedQuery) {
    return bridgedQuery;
  }

  return hasSignedOauthQuery(searchStr) ? searchStr.replace(/^\?/u, "") : null;
};

/**
 * Whether the client asked for this interaction with `prompt`: `login` for a
 * fresh sign-in even with a session, `select_account` for the account and
 * organization step even with a single membership.
 */
export const hasOauthPrompt = (
  signedQuery: string | null,
  prompt: "login" | "select_account",
): boolean =>
  signedQuery !== null &&
  (new URLSearchParams(signedQuery).get("prompt") ?? "")
    .split(" ")
    .includes(prompt);

export const getOauthHashFragment = (query: string): string => {
  const fragment = new URLSearchParams();
  fragment.set(OAUTH_QUERY_HASH_PARAM, query);
  return fragment.toString();
};

/**
 * Where switching accounts on an OAuth step leads once the current account is
 * signed out: sign-in carrying the same signed OAuth request, or, for a page
 * reached without one, back to that page after sign-in.
 */
export const getOauthAccountSwitchHref = ({
  hash,
  pathname,
  search,
}: {
  hash: string;
  pathname: string;
  search: string;
}): string => {
  const bridgedQuery = getSignedOauthQueryFromHash(hash);
  if (bridgedQuery) {
    return `/auth#${getOauthHashFragment(bridgedQuery)}`;
  }

  return `/auth?${new URLSearchParams({ redirectTo: pathname + search })}`;
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

export const oauthConsentInfoSchema = v.object({
  client_name: v.nullable(v.string()),
  redirectTargets: v.array(v.string()),
  clientIdHost: v.nullable(v.string()),
  unverified: v.boolean(),
  // An omitted brand reads as "no verified brand", never as an error.
  verifiedBrand: v.optional(
    v.nullable(v.picklist(VERIFIED_OAUTH_CLIENT_BRANDS)),
    null,
  ),
});

export type OAuthConsentInfo = v.InferOutput<typeof oauthConsentInfoSchema>;
