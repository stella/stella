import { Result } from "better-result";

import { UnsupportedOAuthScopesError } from "./errors.js";

export type NegotiatedOAuthScopes = {
  readonly registrationScopes: readonly string[];
  readonly requestedScopes: readonly string[];
};

type NegotiateOAuthScopesOptions = {
  readonly advertisedScopes: readonly string[] | undefined;
  readonly registrationScopes: readonly string[];
  readonly requestedScopes: readonly string[];
  readonly requiredScopes: readonly string[];
};

/**
 * Restricts the CLI's OAuth requests to scopes the authorization server says
 * it supports. Metadata predating `scopes_supported` remains usable because
 * RFC 8414 makes that field optional; in that case the server still makes the
 * final decision at its registration and authorization endpoints.
 */
export const negotiateOAuthScopes = ({
  advertisedScopes,
  registrationScopes,
  requestedScopes,
  requiredScopes,
}: NegotiateOAuthScopesOptions): Result<
  NegotiatedOAuthScopes,
  UnsupportedOAuthScopesError
> => {
  if (advertisedScopes === undefined) {
    return Result.ok({
      registrationScopes: [
        ...registrationScopes,
        ...requestedScopes.filter(
          (scope) => !registrationScopes.includes(scope),
        ),
      ],
      requestedScopes,
    });
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

  const registrationCandidates = [
    ...registrationScopes,
    ...requestedScopes.filter((scope) => !registrationScopes.includes(scope)),
  ];
  return Result.ok({
    registrationScopes: registrationCandidates.filter((scope) =>
      supported.has(scope),
    ),
    requestedScopes: requestedScopes.filter((scope) => supported.has(scope)),
  });
};
