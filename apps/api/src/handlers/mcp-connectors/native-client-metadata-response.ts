import { t } from "elysia";
import type { Static } from "elysia";

import type { MobileClientMetadataDocument } from "@stll/api-contract/mobile-client";
import type { CliClientMetadataDocument } from "@stll/cli/client-metadata-document";

const URL_MAX_LENGTH = 2048;

/** The response of every Client ID Metadata Document stella publishes for its own native apps. */
export const nativeClientMetadataResponseSchema = t.Object({
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

// The schema's static type takes mutable arrays; the shared documents are
// readonly.
export const toNativeClientMetadataResponse = (
  document: CliClientMetadataDocument | MobileClientMetadataDocument,
): Static<typeof nativeClientMetadataResponseSchema> => ({
  ...document,
  grant_types: [...document.grant_types],
  redirect_uris: [...document.redirect_uris],
  response_types: [...document.response_types],
});
