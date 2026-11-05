// Codes a sign-in callback can put in the error page's `error` query
// parameter: provider codes (RFC 6749 section 4.1.2.1 and OpenID Connect Core
// section 3.1.2.6), Better Auth 1.7 callback codes, and the API's identity
// policy refusal. The parameter is untrusted URL input, so clients report only
// a listed code.
export const OAUTH_CALLBACK_ERROR_CODES = [
  "access_denied",
  "invalid_request",
  "unauthorized_client",
  "unsupported_response_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
  "interaction_required",
  "login_required",
  "consent_required",
  "account_selection_required",
  "no_code",
  "oauth_provider_not_found",
  "issuer_missing",
  "issuer_mismatch",
  "invalid_code",
  "nonce_binding_missing",
  "unable_to_get_user_info",
  "no_callback_url",
  "unable_to_link_account",
  "unable_to_update_account",
  "email_does_not_match",
  "account_already_linked_to_different_user",
  "email_not_found",
  "email_not_verified",
  "state_not_found",
  "state_mismatch",
  "internal_server_error",
  "account_not_linked",
  "signup_disabled",
  "unable_to_create_user",
  "unable_to_create_session",
  "validation_failed",
  "account_ownership_conflict",
  "account_hook_binding_conflict",
  "user_hook_selection_conflict",
  "session_hook_user_conflict",
  "user_not_found",
  "identity_not_allowed",
] as const;

export type OAuthCallbackErrorCode =
  (typeof OAUTH_CALLBACK_ERROR_CODES)[number];
