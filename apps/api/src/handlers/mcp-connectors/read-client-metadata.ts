import { Result } from "better-result";
import { t } from "elysia";
import type { Static } from "elysia";

import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { buildMcpClientMetadataDocument } from "@/api/lib/mcp-upstream/oauth";
import type { McpClientMetadataDocument } from "@/api/lib/mcp-upstream/oauth";

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

type ExactShape<TLeft, TRight> = [TLeft] extends [TRight]
  ? [TRight] extends [TLeft]
    ? true
    : never
  : never;

// The wire schema and the built document must name the same fields, so a
// field added to the document cannot be dropped from the response unseen.
true satisfies ExactShape<
  McpClientMetadataDocument,
  Static<typeof clientMetadataResponseSchema>
>;

const readClientMetadata = createSafeBoundedPublicHandler(
  {
    cache: { kind: "public", maxAge: 3600 },
    accountAccess: ACCOUNT_ACCESS.sandbox,
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
