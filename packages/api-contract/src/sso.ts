/**
 * The error code a request answers with when its organization requires
 * single sign-on and the session was not created by that organization's
 * identity provider. Only that organization refuses the session: the
 * account stays signed in, and the client offers the organization's SSO
 * sign-in instead of signing out.
 */
export const SSO_SIGN_IN_REQUIRED_CODE = "sso_sign_in_required";
