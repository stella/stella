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

export const oauthConsentInfoSchema = v.object({
  client_name: v.nullable(v.string()),
  redirectHosts: v.array(v.string()),
  clientIdHost: v.nullable(v.string()),
  unverified: v.boolean(),
  verifiedBrand: v.nullable(v.picklist(VERIFIED_OAUTH_CLIENT_BRANDS)),
});

export type OAuthConsentInfo = v.InferOutput<typeof oauthConsentInfoSchema>;
