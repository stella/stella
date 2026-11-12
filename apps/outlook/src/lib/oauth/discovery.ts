import { Result } from "better-result";
import * as v from "valibot";

import {
  OUTLOOK_CLIENT_NAME,
  OUTLOOK_SCOPES,
  outlookClientMetadataUrl,
} from "@stll/api-contract/outlook-client";
import { createFetchWithTimeout } from "@stll/fetch";
import { readBodyJsonWithIdleDeadline } from "@stll/fetch/body-reader";

import { SignInError } from "@/lib/oauth/errors";

/** The network, injected so tests own it and development can use its proxy. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * How long the server has to answer with headers, and then the longest its
 * body may stall between two chunks.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/** Metadata, registration and token answers are a few kilobytes. */
const MAX_ANSWER_BYTES = 256 * 1024;

type OAuthAnswer = {
  readonly json: unknown;
  readonly ok: boolean;
  readonly status: number;
};

/**
 * One request to the authorization server, its body read as JSON. Rejects
 * when the headers do not arrive in time, the body stalls or outgrows its
 * cap, or the body is not JSON; callers wrap it in `Result.tryPromise`.
 */
export const sendOAuthRequest = async (
  fetch: Fetch,
  url: string,
  init: Pick<RequestInit, "body" | "headers" | "method">,
): Promise<OAuthAnswer> => {
  // The wrapper hands `url` back unchanged; the injected fetch takes it as
  // the string it already is.
  const response = await createFetchWithTimeout(
    async (_input, transportInit) => await fetch(url, transportInit),
  )(url, {
    ...init,
    credentials: "omit",
    timeout: { type: "headers", ms: REQUEST_TIMEOUT_MS },
  });
  const json = await readBodyJsonWithIdleDeadline(response, {
    idleMs: REQUEST_TIMEOUT_MS,
    maxBytes: MAX_ANSWER_BYTES,
  });
  return { json, ok: response.ok, status: response.status };
};

/**
 * RFC 8414 metadata paths, tried in order: the spec's root-issuer location,
 * then better-auth's own mount, which is where stella serves it. The mobile
 * app and the CLI try the same two.
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

/** Production builds accept only https; development also a loopback http API. */
export type TransportPolicy = { readonly allowLoopbackHttp: boolean };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const isSecureTransport = (url: URL, policy: TransportPolicy): boolean =>
  url.protocol === "https:" ||
  (policy.allowLoopbackHttp &&
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.has(url.hostname));

const readCandidate = async (
  fetch: Fetch,
  url: string,
): Promise<AuthorizationServerMetadata | undefined> => {
  const answer = await Result.tryPromise(
    async () =>
      await sendOAuthRequest(fetch, url, {
        headers: { Accept: "application/json" },
      }),
  );
  if (Result.isError(answer) || !answer.value.ok) {
    return undefined;
  }
  const parsed = v.safeParse(
    authorizationServerMetadataSchema,
    answer.value.json,
  );
  return parsed.success ? parsed.output : undefined;
};

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
    const url = URL.parse(endpoint);
    return url !== null && isSecureTransport(url, policy);
  });

/**
 * The authorization server behind the API origin. A server without S256 PKCE
 * is refused: the add-in is a public client, and PKCE is what keeps an
 * intercepted authorization code useless.
 */
export const discoverAuthorizationServer = async ({
  apiOrigin,
  fetch,
  policy,
}: {
  readonly apiOrigin: string;
  readonly fetch: Fetch;
  readonly policy: TransportPolicy;
}): Promise<Result<AuthorizationServerMetadata, SignInError>> => {
  const [rootPath, mountedPath] = AUTHORIZATION_SERVER_METADATA_PATHS;
  const metadata =
    (await readCandidate(fetch, `${apiOrigin}${rootPath}`)) ??
    (await readCandidate(fetch, `${apiOrigin}${mountedPath}`));
  if (metadata === undefined) {
    return Result.err(
      new SignInError({
        message: `No OAuth authorization server metadata at ${apiOrigin}`,
        failure: "unavailable",
      }),
    );
  }
  if (metadata.code_challenge_methods_supported?.includes("S256") !== true) {
    return Result.err(
      new SignInError({
        message: `The authorization server at ${apiOrigin} does not offer S256 PKCE`,
        failure: "unavailable",
      }),
    );
  }
  if (!endpointsAreSecure(metadata, policy)) {
    return Result.err(
      new SignInError({
        message: `The authorization server at ${apiOrigin} advertises an endpoint without https`,
        failure: "unavailable",
      }),
    );
  }
  return Result.ok(metadata);
};

const isLoopbackRedirect = (redirectUri: string): boolean => {
  const hostname = URL.parse(redirectUri)?.hostname;
  return hostname !== undefined && LOOPBACK_HOSTS.has(hostname);
};

const registrationResponseSchema = v.object({ client_id: v.string() });

/**
 * The add-in's `client_id` on this server: the metadata document stella
 * publishes for it, or, on a server that cannot use one (a local http API,
 * whose documents cannot have an https id), a client registered for this
 * sign-in.
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
}): Promise<Result<string, SignInError>> => {
  const documentClientId =
    metadata.client_id_metadata_document_supported === true
      ? outlookClientMetadataUrl(metadata.issuer)
      : undefined;
  if (documentClientId !== undefined) {
    return Result.ok(documentClientId);
  }
  const endpoint = metadata.registration_endpoint;
  if (endpoint === undefined) {
    return Result.err(
      new SignInError({
        message:
          "The server neither resolves client metadata documents nor allows registration",
        failure: "unavailable",
      }),
    );
  }
  const answered = await Result.tryPromise(
    async () =>
      await sendOAuthRequest(fetch, endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // The server refuses a `web` client with a loopback redirect, which
          // is what a local task pane has; it registers as `native` like the
          // mobile app does against a local server.
          application_type: isLoopbackRedirect(redirectUri) ? "native" : "web",
          client_name: OUTLOOK_CLIENT_NAME,
          grant_types: ["authorization_code", "refresh_token"],
          redirect_uris: [redirectUri],
          resources: [resource],
          response_types: ["code"],
          scope: OUTLOOK_SCOPES.join(" "),
          token_endpoint_auth_method: "none",
        }),
      }),
  );
  const registration =
    Result.isOk(answered) && answered.value.ok
      ? v.safeParse(registrationResponseSchema, answered.value.json)
      : undefined;
  if (registration?.success !== true) {
    return Result.err(
      new SignInError({
        message: "Client registration failed",
        failure: "unavailable",
        cause: Result.isError(answered) ? answered.error : undefined,
      }),
    );
  }
  return Result.ok(registration.output.client_id);
};
