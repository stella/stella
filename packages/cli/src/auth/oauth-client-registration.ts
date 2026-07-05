// Dynamic client registration (RFC 7591) against a `registration_endpoint`
// better-auth's oauth-provider exposes with `allowDynamicClientRegistration`
// and `allowUnauthenticatedClientRegistration` both enabled (see
// `apps/api/src/lib/auth.ts`). Unauthenticated registration always resolves
// to a public client (`token_endpoint_auth_method: "none"`) server-side
// regardless of what the request asks for, so the CLI's request body is
// mostly documentation of intent.

import { Result } from "better-result";
import * as v from "valibot";

import {
  AUTH_FETCH_TIMEOUT_MS,
  CLIENT_NAME,
  LOOPBACK_REDIRECT_URI,
} from "./constants.js";
import { ClientRegistrationError } from "./errors.js";
import type { AuthorizationServerMetadata } from "./oauth-metadata.js";

const registrationResponseSchema = v.looseObject({
  client_id: v.string(),
});

/** Registers a fresh public loopback client with the requested scopes. */
export const registerLoopbackClient = async (
  metadata: AuthorizationServerMetadata,
  scopes: readonly string[],
): Promise<Result<string, ClientRegistrationError>> => {
  if (!metadata.registration_endpoint) {
    return Result.err(
      new ClientRegistrationError({
        message:
          "The server does not advertise a registration_endpoint (allowDynamicClientRegistration is off). A pre-registered loopback client id would need to be configured out of band; this is a server-side gap, not something the CLI can work around.",
      }),
    );
  }

  const body = {
    client_name: CLIENT_NAME,
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uris: [LOOPBACK_REDIRECT_URI],
    response_types: ["code"],
    scope: scopes.join(" "),
    token_endpoint_auth_method: "none",
    type: "native",
  };

  return await Result.tryPromise({
    catch: (cause) =>
      cause instanceof ClientRegistrationError
        ? cause
        : new ClientRegistrationError({
            cause,
            message: "Failed to register the stella CLI as an OAuth client",
          }),
    try: async () => {
      const response = await fetch(metadata.registration_endpoint ?? "", {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new ClientRegistrationError({
          message: `registration_endpoint responded ${response.status}: ${text}`,
        });
      }

      const json: unknown = await response.json();
      const parsed = v.parse(registrationResponseSchema, json);
      return parsed.client_id;
    },
  });
};
