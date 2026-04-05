const OAUTH_SIGNATURE_PARAM = "sig";

export const hasSignedOauthQuery = (search: string) => {
  const query = search.startsWith("?") ? search.slice(1) : search;
  if (query.length === 0) {
    return false;
  }

  return new URLSearchParams(query).has(OAUTH_SIGNATURE_PARAM);
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
