import { Result } from "better-result";

import { MOBILE_SCOPES } from "@stll/api-contract/mobile-client";

import type { AuthorizationServerMetadata } from "./discovery";
import { AuthorizationError } from "./errors";
import { parseUrl } from "./http";

export const buildAuthorizeUrl = ({
  clientId,
  codeChallenge,
  metadata,
  redirectUri,
  resource,
  state,
}: {
  readonly clientId: string;
  readonly codeChallenge: string;
  readonly metadata: AuthorizationServerMetadata;
  /** This build's redirect (`mobileRedirectUri`). */
  readonly redirectUri: string;
  readonly resource: string;
  readonly state: string;
}): string => {
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("resource", resource);
  url.searchParams.set("scope", MOBILE_SCOPES.join(" "));
  // Native clients are public, so the server asks for consent on every
  // grant anyway (RFC 8252 §8.6); asking up front keeps the flow one page.
  url.searchParams.set("prompt", "consent");
  return url.toString();
};

/**
 * The authorization code a browser callback carries for this attempt.
 *
 * The callback must come back on the app's own redirect and repeat the
 * attempt's `state`. Its issuer (RFC 9207) must be the one the attempt
 * started with, so a response from another server cannot be redeemed here;
 * a server that promises to name its issuer must do so.
 */
export const readAuthorizationCallback = ({
  callbackUrl,
  expectedIssuer,
  expectedState,
  issuerRequired,
  redirectUri,
}: {
  readonly callbackUrl: string;
  readonly expectedIssuer: string;
  readonly expectedState: string;
  /** `authorization_response_iss_parameter_supported` from the server's metadata. */
  readonly issuerRequired: boolean;
  readonly redirectUri: string;
}): Result<string, AuthorizationError> => {
  const url = parseUrl(callbackUrl);
  const redirect = new URL(redirectUri);
  if (
    url === null ||
    url.protocol !== redirect.protocol ||
    url.pathname !== redirect.pathname
  ) {
    return Result.err(
      new AuthorizationError({
        message: "The callback is not the app's redirect",
        failure: "malformed",
      }),
    );
  }
  const parameters = url.searchParams;
  if (parameters.get("state") !== expectedState) {
    return Result.err(
      new AuthorizationError({
        message: "The callback answers a different sign-in attempt",
        failure: "mismatched",
      }),
    );
  }
  const issuer = parameters.get("iss");
  if (issuer === null ? issuerRequired : issuer !== expectedIssuer) {
    return Result.err(
      new AuthorizationError({
        message: "The callback comes from a different authorization server",
        failure: "mismatched",
      }),
    );
  }
  const error = parameters.get("error");
  if (error !== null) {
    return Result.err(
      new AuthorizationError({
        message: `The authorization server refused: ${error}`,
        failure: "denied",
      }),
    );
  }
  const code = parameters.get("code");
  if (code === null || code === "") {
    return Result.err(
      new AuthorizationError({
        message: "The callback carries no authorization code",
        failure: "malformed",
      }),
    );
  }
  return Result.ok(code);
};
