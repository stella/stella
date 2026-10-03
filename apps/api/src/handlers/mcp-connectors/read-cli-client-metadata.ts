import { Result } from "better-result";
import { t } from "elysia";
import type { Static } from "elysia";

import type { CliClientMetadataDocument } from "@stll/cli/client-metadata-document";

import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { getCliClientMetadataDocument } from "@/api/lib/auth/oauth-own-client-documents";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const URL_MAX_LENGTH = 2048;

const cliClientMetadataResponseSchema = t.Object({
  client_id: t.String({ maxLength: URL_MAX_LENGTH }),
  client_name: t.String({ maxLength: 256 }),
  application_type: t.Literal("native"),
  grant_types: t.Array(
    t.Union([t.Literal("authorization_code"), t.Literal("refresh_token")]),
    { maxItems: 2 },
  ),
  redirect_uris: t.Array(t.String({ maxLength: URL_MAX_LENGTH }), {
    maxItems: 8,
  }),
  response_types: t.Array(t.Literal("code"), { maxItems: 1 }),
  scope: t.String({ maxLength: 4096 }),
  token_endpoint_auth_method: t.Literal("none"),
});

// The schema's static type takes mutable arrays; the shared document is
// readonly.
const toResponse = (
  document: CliClientMetadataDocument,
): Static<typeof cliClientMetadataResponseSchema> => ({
  ...document,
  grant_types: [...document.grant_types],
  redirect_uris: [...document.redirect_uris],
  response_types: [...document.response_types],
});

const readCliClientMetadata = createSafeBoundedPublicHandler(
  {
    cache: { kind: "public", maxAge: 3600 },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "auth_plumbing" },
    response: safePublicHandlerResponseSchemasWithStatusText(
      cliClientMetadataResponseSchema,
    ),
  },
  async function* () {
    const found = getCliClientMetadataDocument();
    const document = yield* Result.await(
      Promise.resolve(
        found
          ? Result.ok(found)
          : Result.err(new HandlerError({ status: 404, message: "Not found" })),
      ),
    );
    return Result.ok(toResponse(document));
  },
);

export default readCliClientMetadata;
