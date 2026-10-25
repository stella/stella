import { Result } from "better-result";
import * as v from "valibot";

import type { CliClientMetadataDocument } from "@stll/cli/client-metadata-document";

import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { getCliClientMetadataDocument } from "@/api/lib/auth/oauth-own-client-documents";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const URL_MAX_LENGTH = 2048;

const cliClientMetadataResponseSchema = v.object({
  client_id: v.pipe(v.string(), v.maxLength(URL_MAX_LENGTH)),
  client_name: v.pipe(v.string(), v.maxLength(256)),
  application_type: v.literal("native"),
  grant_types: v.pipe(
    v.array(v.picklist(["authorization_code", "refresh_token"])),
    v.maxLength(2),
  ),
  redirect_uris: v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(URL_MAX_LENGTH))),
    v.maxLength(8),
  ),
  response_types: v.pipe(v.array(v.literal("code")), v.maxLength(1)),
  scope: v.pipe(v.string(), v.maxLength(4096)),
  token_endpoint_auth_method: v.literal("none"),
});

// The schema's static type takes mutable arrays; the shared document is
// readonly.
const toResponse = (
  document: CliClientMetadataDocument,
): v.InferOutput<typeof cliClientMetadataResponseSchema> => ({
  ...document,
  grant_types: [...document.grant_types],
  redirect_uris: [...document.redirect_uris],
  response_types: [...document.response_types],
});

const readCliClientMetadata = createSafeBoundedPublicHandler(
  {
    contract: "patch",
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
