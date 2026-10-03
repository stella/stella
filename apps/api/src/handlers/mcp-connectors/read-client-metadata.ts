import { Result } from "better-result";
import { t } from "elysia";

import {
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { buildMcpClientMetadataDocument } from "@/api/lib/mcp-upstream/oauth";

const URL_MAX_LENGTH = 2048;
const TOKEN_MAX_LENGTH = 64;

const clientMetadataResponseSchema = t.Object({
  client_id: t.String({ maxLength: URL_MAX_LENGTH }),
  client_name: t.String({ maxLength: 256 }),
  client_uri: t.String({ maxLength: URL_MAX_LENGTH }),
  grant_types: t.Array(t.String({ maxLength: TOKEN_MAX_LENGTH }), {
    maxItems: 4,
  }),
  redirect_uris: t.Array(t.String({ maxLength: URL_MAX_LENGTH }), {
    maxItems: 8,
  }),
  response_types: t.Array(t.String({ maxLength: TOKEN_MAX_LENGTH }), {
    maxItems: 4,
  }),
  token_endpoint_auth_method: t.Literal("none"),
});

const readClientMetadata = createSafeBoundedPublicHandler(
  {
    cache: { kind: "public", maxAge: 3600 },
    mcp: { type: "internal", reason: "auth_plumbing" },
    response: safePublicHandlerResponseSchemasWithStatusText(
      clientMetadataResponseSchema,
    ),
  },
  async function* () {
    const metadata = yield* Result.await(
      Promise.resolve(Result.try(buildMcpClientMetadataDocument)),
    );
    return Result.ok(metadata);
  },
);

export default readClientMetadata;
