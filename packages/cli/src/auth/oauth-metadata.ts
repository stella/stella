// RFC 8414 authorization-server-metadata discovery.

import { Result } from "better-result";
import * as v from "valibot";

import {
  AUTH_FETCH_TIMEOUT_MS,
  AUTHORIZATION_SERVER_METADATA_PATHS,
} from "./constants.js";
import { OAuthMetadataError } from "./errors.js";

// Hand-written rather than `v.InferOutput<typeof schema>` (see
// `cli-config.ts` for why: this package builds with `isolatedDeclarations`).
export type AuthorizationServerMetadata = {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly registration_endpoint?: string | undefined;
  readonly code_challenge_methods_supported?: readonly string[] | undefined;
  readonly scopes_supported?: readonly string[] | undefined;
  readonly token_endpoint_auth_methods_supported?:
    | readonly string[]
    | undefined;
};

const authorizationServerMetadataSchema = v.object({
  issuer: v.pipe(v.string(), v.url()),
  authorization_endpoint: v.pipe(v.string(), v.url()),
  token_endpoint: v.pipe(v.string(), v.url()),
  registration_endpoint: v.optional(v.pipe(v.string(), v.url())),
  code_challenge_methods_supported: v.optional(v.array(v.string())),
  scopes_supported: v.optional(v.array(v.string())),
  token_endpoint_auth_methods_supported: v.optional(v.array(v.string())),
});

const fetchCandidate = async (
  url: string,
): Promise<AuthorizationServerMetadata | undefined> => {
  const attempt = await Result.tryPromise(async () => {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
    });
    return response.ok ? await response.json() : undefined;
  });
  if (Result.isError(attempt) || attempt.value === undefined) {
    return undefined;
  }

  const parsed = v.safeParse(authorizationServerMetadataSchema, attempt.value);
  return parsed.success ? parsed.output : undefined;
};

/**
 * Discovers the OAuth authorization-server metadata for `serverUrl` by
 * trying both the RFC 8414 root-issuer path and better-auth's actual mount
 * path (see `AUTHORIZATION_SERVER_METADATA_PATHS`), in order. The two
 * candidates are unrolled explicitly (not looped) so the second request
 * only ever fires once the first has definitively failed.
 */
export const discoverAuthorizationServerMetadata = async (
  serverUrl: string,
): Promise<Result<AuthorizationServerMetadata, OAuthMetadataError>> => {
  const origin = serverUrl.replace(/\/$/u, "");
  const [rootPath, mountedPath] = AUTHORIZATION_SERVER_METADATA_PATHS;

  const found =
    (await fetchCandidate(`${origin}${rootPath}`)) ??
    (await fetchCandidate(`${origin}${mountedPath}`));

  if (found) {
    return Result.ok(found);
  }

  return Result.err(
    new OAuthMetadataError({
      message: `Could not discover OAuth authorization server metadata at ${serverUrl}. Pass --server pointing at the stella API origin (not the web app), and confirm the server exposes ${AUTHORIZATION_SERVER_METADATA_PATHS.join(" or ")}.`,
      serverUrl,
    }),
  );
};
