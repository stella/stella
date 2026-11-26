import { Result } from "better-result";
import * as v from "valibot";

import { handleOAuthAuthorizationServerMetadataRequest } from "@/api/handlers/auth/metadata";
import {
  ACCOUNT_ACCESS,
  createSafePublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { DISCOVERY_METADATA_CACHE_POLICY } from "@/api/lib/security-headers";

const URL_MAX_LENGTH = 2048;
const TOKEN_MAX_LENGTH = 128;
const TOKEN_LIST_MAX_LENGTH = 64;

const urlSchema = v.pipe(v.string(), v.maxLength(URL_MAX_LENGTH));
const tokenSchema = v.pipe(v.string(), v.maxLength(TOKEN_MAX_LENGTH));
const tokenListSchema = v.pipe(
  v.array(tokenSchema),
  v.maxLength(TOKEN_LIST_MAX_LENGTH),
);

export const authorizationServerMetadataResponseSchema = v.object({
  issuer: urlSchema,
  authorization_endpoint: urlSchema,
  token_endpoint: urlSchema,
  jwks_uri: v.optional(urlSchema),
  registration_endpoint: v.optional(urlSchema),
  scopes_supported: v.optional(tokenListSchema),
  response_types_supported: tokenListSchema,
  response_modes_supported: v.optional(tokenListSchema),
  grant_types_supported: v.optional(tokenListSchema),
  token_endpoint_auth_methods_supported: v.optional(tokenListSchema),
  token_endpoint_auth_signing_alg_values_supported: v.optional(tokenListSchema),
  service_documentation: v.optional(urlSchema),
  ui_locales_supported: v.optional(tokenListSchema),
  op_policy_uri: v.optional(urlSchema),
  op_tos_uri: v.optional(urlSchema),
  revocation_endpoint: v.optional(urlSchema),
  revocation_endpoint_auth_methods_supported: v.optional(tokenListSchema),
  revocation_endpoint_auth_signing_alg_values_supported:
    v.optional(tokenListSchema),
  introspection_endpoint: v.optional(urlSchema),
  introspection_endpoint_auth_methods_supported: v.optional(tokenListSchema),
  introspection_endpoint_auth_signing_alg_values_supported:
    v.optional(tokenListSchema),
  device_authorization_endpoint: v.optional(urlSchema),
  code_challenge_methods_supported: v.optional(tokenListSchema),
  authorization_response_iss_parameter_supported: v.optional(v.boolean()),
  client_id_metadata_document_supported: v.optional(v.boolean()),
  backchannel_logout_supported: v.optional(v.boolean()),
  backchannel_logout_session_supported: v.optional(v.boolean()),
  dpop_signing_alg_values_supported: v.optional(tokenListSchema),
  userinfo_endpoint: v.optional(urlSchema),
  acr_values_supported: v.optional(tokenListSchema),
  subject_types_supported: v.optional(tokenListSchema),
  id_token_signing_alg_values_supported: v.optional(tokenListSchema),
  claims_supported: v.optional(tokenListSchema),
  agent_auth: v.object({
    skill: urlSchema,
    identity_endpoint: urlSchema,
    claim_endpoint: urlSchema,
    events_endpoint: urlSchema,
    identity_types_supported: tokenListSchema,
    identity_assertion: v.object({
      assertion_types_supported: tokenListSchema,
    }),
    events_supported: tokenListSchema,
  }),
});

const readAuthorizationServerMetadata = createSafePublicHandler(
  {
    contract: "patch",
    cache: DISCOVERY_METADATA_CACHE_POLICY,
    // Any origin may read it; the answer carries its own CORS headers.
    cors: "own",
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "auth_plumbing" },
    response: safePublicHandlerResponseSchemasWithStatusText(
      authorizationServerMetadataResponseSchema,
    ),
  },
  async function* ({ request, set }) {
    const response = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await handleOAuthAuthorizationServerMetadataRequest(request),
        catch: () =>
          new HandlerError({
            status: 502,
            code: "metadata_unavailable",
            message: "Authorization server metadata is unavailable",
          }),
      }),
    );
    for (const [key, value] of response.headers.entries()) {
      if (key.toLowerCase() !== "content-length") {
        set.headers[key] = value;
      }
    }
    if (!response.ok) {
      const detail = yield* Result.await(
        Result.tryPromise({
          try: async () => await response.text(),
          catch: () =>
            new HandlerError({
              status: 502,
              code: "metadata_unavailable",
              message: "Authorization server metadata is unavailable",
            }),
        }),
      );
      let errorStatus: 400 | 404 | 502 = 502;
      if (response.status === 404) {
        errorStatus = 404;
      } else if (response.status === 400) {
        errorStatus = 400;
      }
      return Result.err(
        new HandlerError({
          status: errorStatus,
          code: "metadata_unavailable",
          message:
            detail.trim().slice(0, 256) ||
            "Authorization server metadata is unavailable",
        }),
      );
    }
    const payload: unknown = yield* Result.await(
      Result.tryPromise({
        try: async () => await response.json(),
        catch: () =>
          new HandlerError({
            status: 500,
            code: "invalid_response",
            message: "Authorization server metadata failed response validation",
          }),
      }),
    );
    const parsed = v.safeParse(
      authorizationServerMetadataResponseSchema,
      payload,
    );
    if (!parsed.success) {
      return Result.err(
        new HandlerError({
          status: 500,
          code: "invalid_response",
          message: "Authorization server metadata failed response validation",
        }),
      );
    }
    set.status = response.status;
    return Result.ok(parsed.output);
  },
);

export default readAuthorizationServerMetadata;
