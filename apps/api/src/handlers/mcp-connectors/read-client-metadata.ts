import { Result } from "better-result";
import * as v from "valibot";

import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { buildMcpClientMetadataDocument } from "@/api/lib/mcp-upstream/oauth";
import type { McpClientMetadataDocument } from "@/api/lib/mcp-upstream/oauth";

const URL_MAX_LENGTH = 2048;
const TOKEN_MAX_LENGTH = 64;

const clientMetadataResponseSchema = v.object({
  client_id: v.pipe(v.string(), v.maxLength(URL_MAX_LENGTH)),
  client_name: v.pipe(v.string(), v.maxLength(256)),
  client_uri: v.pipe(v.string(), v.maxLength(URL_MAX_LENGTH)),
  grant_types: v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(TOKEN_MAX_LENGTH))),
    v.maxLength(4),
  ),
  redirect_uris: v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(URL_MAX_LENGTH))),
    v.maxLength(8),
  ),
  response_types: v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(TOKEN_MAX_LENGTH))),
    v.maxLength(4),
  ),
  token_endpoint_auth_method: v.literal("none"),
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
  v.InferOutput<typeof clientMetadataResponseSchema>
>;

const readClientMetadata = createSafeBoundedPublicHandler(
  {
    contract: "patch",
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
