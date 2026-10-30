import * as v from "valibot";

import type { MobileClientMetadataDocument } from "@stll/api-contract/mobile-client";
import type { CliClientMetadataDocument } from "@stll/cli/client-metadata-document";

const URL_MAX_LENGTH = 2048;

/** The response of every Client ID Metadata Document stella publishes for its own native apps. */
export const nativeClientMetadataResponseSchema = v.object({
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

// The schema's static type takes mutable arrays; the shared documents are
// readonly.
export const toNativeClientMetadataResponse = (
  document: CliClientMetadataDocument | MobileClientMetadataDocument,
): v.InferOutput<typeof nativeClientMetadataResponseSchema> => ({
  ...document,
  grant_types: [...document.grant_types],
  redirect_uris: [...document.redirect_uris],
  response_types: [...document.response_types],
});
