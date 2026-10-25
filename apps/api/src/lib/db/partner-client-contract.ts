/**
 * `oauth_client.type` of a partner client: a hosted assistant that cannot
 * register itself (no dynamic registration), so an operator registers one
 * confidential client for it. Its users sign in and consent like any other
 * client's. Loads no auth runtime.
 */
export const PARTNER_CLIENT_TYPE = "partner";
