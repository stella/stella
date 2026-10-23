/**
 * How long a browser may reuse the preflight of a public, bearer-or-anonymous
 * endpoint (the MCP transport and the OAuth discovery documents). Browsers cap
 * it lower on their own; the value only has to outlast a working session.
 */
export const PUBLIC_CORS_PREFLIGHT_MAX_AGE_SECONDS = 86_400;
