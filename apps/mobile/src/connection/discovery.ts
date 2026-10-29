import { Result } from "better-result";
import * as v from "valibot";

import { DiscoveryError } from "./errors";
import { fetchWithTimeout, parseUrl } from "./http";
import type { Fetch } from "./http";
import { isSecureTransport } from "./server-url";
import type { TransportPolicy } from "./server-url";

/**
 * RFC 8414 metadata paths, tried in order: the spec's root-issuer location,
 * then better-auth's own mount, which is where stella serves it. The CLI
 * tries the same two.
 */
const AUTHORIZATION_SERVER_METADATA_PATHS = [
  "/.well-known/oauth-authorization-server",
  "/api/auth/.well-known/oauth-authorization-server",
] as const;

const authorizationServerMetadataSchema = v.object({
  issuer: v.pipe(v.string(), v.url()),
  authorization_endpoint: v.pipe(v.string(), v.url()),
  token_endpoint: v.pipe(v.string(), v.url()),
  registration_endpoint: v.optional(v.pipe(v.string(), v.url())),
  revocation_endpoint: v.optional(v.pipe(v.string(), v.url())),
  authorization_response_iss_parameter_supported: v.optional(v.boolean()),
  client_id_metadata_document_supported: v.optional(v.boolean()),
  code_challenge_methods_supported: v.optional(v.array(v.string())),
});

export type AuthorizationServerMetadata = v.InferOutput<
  typeof authorizationServerMetadataSchema
>;

const readCandidate = async (
  fetch: Fetch,
  url: string,
): Promise<AuthorizationServerMetadata | undefined> => {
  const body = await Result.tryPromise(async (): Promise<unknown> => {
    const response = await fetchWithTimeout(fetch, url, {
      headers: { Accept: "application/json" },
    });
    return response.ok ? await response.json() : undefined;
  });
  if (Result.isError(body) || body.value === undefined) {
    return undefined;
  }
  const parsed = v.safeParse(authorizationServerMetadataSchema, body.value);
  return parsed.success ? parsed.output : undefined;
};

/**
 * The issuer and every endpoint the app sends a code, a token or a grant to
 * must use a transport the build trusts. Origins are not compared: stella
 * may serve its authorization server from another host than its public
 * address. What binds a grant to the server the person named is the resource
 * the app requests, which only that server accepts.
 */
const endpointsAreSecure = (
  metadata: AuthorizationServerMetadata,
  policy: TransportPolicy,
): boolean =>
  [
    metadata.issuer,
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.registration_endpoint,
    metadata.revocation_endpoint,
  ].every((endpoint) => {
    if (endpoint === undefined) {
      return true;
    }
    const url = parseUrl(endpoint);
    return url !== null && isSecureTransport(url, policy);
  });

/**
 * The authorization server behind `serverUrl`. A server that does not offer
 * S256 PKCE is refused: the app is a public client, and PKCE is what keeps an
 * intercepted authorization code useless (RFC 8252 §8.1).
 */
export const discoverAuthorizationServer = async (
  fetch: Fetch,
  serverUrl: string,
  policy: TransportPolicy,
): Promise<Result<AuthorizationServerMetadata, DiscoveryError>> => {
  const [rootPath, mountedPath] = AUTHORIZATION_SERVER_METADATA_PATHS;
  const metadata =
    (await readCandidate(fetch, `${serverUrl}${rootPath}`)) ??
    (await readCandidate(fetch, `${serverUrl}${mountedPath}`));
  if (metadata === undefined) {
    return Result.err(
      new DiscoveryError({
        message: `No OAuth authorization server metadata at ${serverUrl}`,
        serverUrl,
      }),
    );
  }
  if (metadata.code_challenge_methods_supported?.includes("S256") !== true) {
    return Result.err(
      new DiscoveryError({
        message: `The authorization server at ${serverUrl} does not offer S256 PKCE`,
        serverUrl,
      }),
    );
  }
  if (!endpointsAreSecure(metadata, policy)) {
    return Result.err(
      new DiscoveryError({
        message: `The authorization server at ${serverUrl} advertises an endpoint without https`,
        serverUrl,
      }),
    );
  }
  return Result.ok(metadata);
};
