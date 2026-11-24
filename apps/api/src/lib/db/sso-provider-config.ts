import { Result } from "better-result";

import { ConfigurationError } from "@/api/lib/errors/tagged-errors";
import { isRecord } from "@/api/lib/type-guards";

/**
 * The invariants a stored OIDC provider configuration must keep, checked on
 * every write and every read of the sealed column, so a row that breaks one
 * can neither be stored nor used to sign anyone in:
 *
 * - `overrideUserInfo` is never on: an identity provider never rewrites the
 *   local email, name or picture of the account it signs in.
 * - `pkce` is on: the authorization code is bound to the sign-in that asked
 *   for it.
 * - `allowIdpInitiated` is never on: a sign-in starts here, so its state
 *   carries the nonce the ID token must repeat. The plugin restarts an
 *   identity-provider-initiated callback without that nonce, so it could
 *   never complete.
 */
export const admitSsoOidcConfig = (
  json: string,
): Result<string, ConfigurationError> => {
  const parsed = Result.try({
    try: (): unknown => JSON.parse(json),
    catch: () =>
      new ConfigurationError({
        message: "SSO provider configuration is not valid JSON",
      }),
  });
  if (Result.isError(parsed)) {
    return Result.err(parsed.error);
  }
  const config = parsed.value;
  if (!isRecord(config)) {
    return Result.err(
      new ConfigurationError({
        message: "SSO provider configuration is not an object",
      }),
    );
  }
  if (
    config["overrideUserInfo"] !== undefined &&
    config["overrideUserInfo"] !== false
  ) {
    return Result.err(
      new ConfigurationError({
        message: "SSO provider configuration may not override user profiles",
      }),
    );
  }
  if (config["pkce"] !== true) {
    return Result.err(
      new ConfigurationError({
        message: "SSO provider configuration must require PKCE",
      }),
    );
  }
  if (
    config["allowIdpInitiated"] !== undefined &&
    config["allowIdpInitiated"] !== false
  ) {
    return Result.err(
      new ConfigurationError({
        message:
          "SSO provider configuration may not allow identity-provider-initiated sign-in",
      }),
    );
  }
  return Result.ok(json);
};

/**
 * The invariants a stored SAML 2.0 provider configuration must keep, checked
 * on every write and every read of the sealed column:
 *
 * - `entryPoint` is an HTTPS URL.
 * - `cert` is a non-empty signing certificate.
 * - `wantAssertionsSigned` is true: unsigned SAML assertions are never admitted.
 * - `overrideUserInfo` is never on.
 * - `allowIdpInitiated` is never on (SAML2Int hardened: SP-initiated only).
 */
export const admitSsoSamlConfig = (
  json: string,
): Result<string, ConfigurationError> => {
  const parsed = Result.try({
    try: (): unknown => JSON.parse(json),
    catch: () =>
      new ConfigurationError({
        message: "SAML provider configuration is not valid JSON",
      }),
  });
  if (Result.isError(parsed)) {
    return Result.err(parsed.error);
  }
  const config = parsed.value;
  if (!isRecord(config)) {
    return Result.err(
      new ConfigurationError({
        message: "SAML provider configuration is not an object",
      }),
    );
  }
  if (
    typeof config["entryPoint"] !== "string" ||
    !config["entryPoint"].startsWith("https://")
  ) {
    return Result.err(
      new ConfigurationError({
        message: "SAML provider entryPoint must be an HTTPS URL",
      }),
    );
  }
  if (
    typeof config["cert"] !== "string" ||
    config["cert"].trim().length === 0
  ) {
    return Result.err(
      new ConfigurationError({
        message: "SAML provider configuration must include an IdP certificate",
      }),
    );
  }
  if (config["wantAssertionsSigned"] !== true) {
    return Result.err(
      new ConfigurationError({
        message: "SAML provider configuration must require signed assertions",
      }),
    );
  }
  if (
    config["overrideUserInfo"] !== undefined &&
    config["overrideUserInfo"] !== false
  ) {
    return Result.err(
      new ConfigurationError({
        message: "SAML provider configuration may not override user profiles",
      }),
    );
  }
  if (
    config["allowIdpInitiated"] !== undefined &&
    config["allowIdpInitiated"] !== false
  ) {
    return Result.err(
      new ConfigurationError({
        message:
          "SAML provider configuration may not allow identity-provider-initiated sign-in",
      }),
    );
  }
  return Result.ok(json);
};
