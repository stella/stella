import { Result } from "better-result";

import { UnsupportedOAuthScopesError } from "./errors.js";

type NegotiateOAuthScopesOptions = {
  readonly advertisedScopes: readonly string[] | undefined;
  readonly requestedScopes: readonly string[];
  readonly requiredScopes: readonly string[];
};

/**
 * Restricts the CLI's authorization request to scopes the authorization
 * server says it supports. Metadata predating `scopes_supported` remains
 * usable because RFC 8414 makes that field optional; in that case the server
 * still makes the final decision at its authorization endpoint.
 */
export const negotiateOAuthScopes = ({
  advertisedScopes,
  requestedScopes,
  requiredScopes,
}: NegotiateOAuthScopesOptions): Result<
  readonly string[],
  UnsupportedOAuthScopesError
> => {
  if (advertisedScopes === undefined) {
    return Result.ok(requestedScopes);
  }

  const supported = new Set(advertisedScopes);
  const missingScopes = requiredScopes.filter((scope) => !supported.has(scope));
  if (missingScopes.length > 0) {
    return Result.err(
      new UnsupportedOAuthScopesError({
        message: `The server cannot satisfy this login because it does not advertise the required OAuth ${missingScopes.length === 1 ? "scope" : "scopes"}: ${missingScopes.join(", ")}. Request scopes supported by this server or upgrade the server.`,
        missingScopes,
      }),
    );
  }

  return Result.ok(requestedScopes.filter((scope) => supported.has(scope)));
};
