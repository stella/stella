// The REST API as an OAuth resource (RFC 8707). Only stella's own native apps
// are linked to it, so a third-party client connected over MCP never holds a
// token the API accepts. Each route opts in with the scope it requires; every
// other route refuses these tokens.

/** The resource identifier's path on the API's public origin. */
export const API_OAUTH_RESOURCE_PATH = "/v1" as const;

export const API_OAUTH_RESOURCE_NAME = "stella API" as const;

/** Every scope a route on this resource may require. */
export const API_OAUTH_RESOURCE_SCOPES = [
  "stella:read",
  "stella:chat",
] as const;

export type ApiOAuthResourceScope = (typeof API_OAUTH_RESOURCE_SCOPES)[number];

/** The resource identifier for an API origin, e.g. `https://api.example.com/v1`. */
export const apiOAuthResourceUrl = (origin: string): string =>
  `${origin.replace(/\/$/u, "")}${API_OAUTH_RESOURCE_PATH}`;
