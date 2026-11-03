import { Result } from "better-result";
import * as v from "valibot";

import {
  MOBILE_CLIENT_NAME,
  MOBILE_SCOPES,
  mobileClientMetadataUrl,
} from "@stll/api-contract/mobile-client";

import type { AuthorizationServerMetadata } from "./discovery";
import { ClientRegistrationError } from "./errors";
import { fetchWithTimeout } from "./http";
import type { Fetch } from "./http";

const registrationResponseSchema = v.object({ client_id: v.string() });

/**
 * The app's `client_id` on this server: the metadata document stella
 * publishes for it, or, on a server that cannot use one (a local http
 * deployment, whose documents cannot have an https id), a client registered
 * for this sign-in.
 */
export const resolveClientId = async ({
  fetch,
  metadata,
  redirectUri,
  resource,
}: {
  readonly fetch: Fetch;
  readonly metadata: AuthorizationServerMetadata;
  readonly redirectUri: string;
  readonly resource: string;
}): Promise<Result<string, ClientRegistrationError>> => {
  const documentClientId =
    metadata.client_id_metadata_document_supported === true
      ? mobileClientMetadataUrl(metadata.issuer)
      : undefined;
  if (documentClientId !== undefined) {
    return Result.ok(documentClientId);
  }
  const endpoint = metadata.registration_endpoint;
  if (endpoint === undefined) {
    return Result.err(
      new ClientRegistrationError({
        message:
          "The server neither resolves client metadata documents nor allows registration",
      }),
    );
  }
  const answered = await Result.tryPromise({
    try: async () => {
      const response = await fetchWithTimeout(fetch, endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // An explicit `native` type is what lets a private-use scheme
        // redirect register (RFC 8252 §7.1).
        body: JSON.stringify({
          application_type: "native",
          client_name: MOBILE_CLIENT_NAME,
          grant_types: ["authorization_code", "refresh_token"],
          redirect_uris: [redirectUri],
          resources: [resource],
          response_types: ["code"],
          scope: MOBILE_SCOPES.join(" "),
          token_endpoint_auth_method: "none",
        }),
      });
      if (!response.ok) {
        return { status: response.status, json: undefined };
      }
      const json: unknown = await response.json();
      return { status: response.status, json };
    },
    catch: (cause) =>
      new ClientRegistrationError({
        message: "Client registration failed",
        cause,
      }),
  });
  if (Result.isError(answered)) {
    return Result.err(answered.error);
  }
  const { status, json } = answered.value;
  if (json === undefined) {
    return Result.err(
      new ClientRegistrationError({
        message: `Client registration responded ${status}`,
      }),
    );
  }
  const registration = v.safeParse(registrationResponseSchema, json);
  return registration.success
    ? Result.ok(registration.output.client_id)
    : Result.err(
        new ClientRegistrationError({
          message: "Client registration answered an unexpected body",
          cause: new v.ValiError(registration.issues),
        }),
      );
};
