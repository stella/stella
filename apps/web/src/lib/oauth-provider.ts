import * as v from "valibot";

import {
  type OAuthConsentClient,
  VERIFIED_OAUTH_CLIENT_BRANDS,
} from "@stll/api-contract";

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

const DESTINATION_BASE = "https://destination.invalid";

/**
 * The page a sign-in destination resumes an authorization on, when the
 * destination carries the signed OAuth request (in its fragment or query).
 *
 * Sign-in steps hand the request on inside `redirectTo`, where no auth call
 * reads it. A page that receives such a destination goes there first, so the
 * request is on the page itself before any step acts on it.
 */
export const getOauthContinuationHref = (
  redirectTo: string | undefined,
): string | null => {
  if (redirectTo === undefined || !URL.canParse(redirectTo, DESTINATION_BASE)) {
    return null;
  }
  const url = new URL(redirectTo, DESTINATION_BASE);
  if (url.origin !== DESTINATION_BASE) {
    return null;
  }
  const carriesRequest =
    getSignedOauthQueryFromHash(url.hash) !== null ||
    hasSignedOauthQuery(url.search);
  return carriesRequest ? `${url.pathname}${url.search}${url.hash}` : null;
};

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

const oauthConsentClientSchema = v.variant("type", [
  v.object({
    type: v.literal("verified"),
    brand: v.picklist(VERIFIED_OAUTH_CLIENT_BRANDS),
  }),
  v.object({
    type: v.literal("verified_unbranded"),
    name: v.nullable(v.string()),
  }),
  v.object({
    type: v.literal("unverified"),
    name: v.nullable(v.string()),
  }),
]) satisfies v.GenericSchema<unknown, OAuthConsentClient>;

export const oauthConsentInfoSchema = v.object({
  client: oauthConsentClientSchema,
  redirectTargets: v.array(v.string()),
  clientIdHost: v.nullable(v.string()),
});

export type OAuthConsentInfo = v.InferOutput<typeof oauthConsentInfoSchema>;
