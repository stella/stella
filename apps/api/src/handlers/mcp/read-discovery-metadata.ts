import { Result } from "better-result";
import { t, type Context, type Static } from "elysia";

import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import type {
  PublicHandlerConfig,
  SafeHandlerGenerator,
} from "@/api/lib/api-handlers";
import type { McpMode } from "@/api/mcp/constants";
import {
  createMcpMetadataHeaders,
  getMcpProtectedResourceMetadata,
} from "@/api/mcp/metadata";

const URL_MAX_LENGTH = 2048;
const METADATA_VALUE_MAX_LENGTH = 256;
const discoveryMetadataSchema = t.Object({
  resource: t.String({ maxLength: URL_MAX_LENGTH }),
  resource_name: t.String({ maxLength: METADATA_VALUE_MAX_LENGTH }),
  resource_logo_uri: t.String({ maxLength: URL_MAX_LENGTH }),
  authorization_servers: t.Array(t.String({ maxLength: URL_MAX_LENGTH }), {
    maxItems: 1,
  }),
  scopes_supported: t.Array(
    t.String({ maxLength: METADATA_VALUE_MAX_LENGTH }),
    { maxItems: 64 },
  ),
  bearer_methods_supported: t.Array(
    t.String({ maxLength: METADATA_VALUE_MAX_LENGTH }),
    { maxItems: 1 },
  ),
  stella_contract: t.Object({
    protocol: t.Integer(),
    revision: t.Integer(),
    capabilities: t.Record(
      t.String({ maxLength: METADATA_VALUE_MAX_LENGTH }),
      t.Integer(),
    ),
  }),
  stella_compatibility: t.Object({
    api_contract_version: t.Integer(),
    cli_version: t.Object({
      minimum: t.String({ maxLength: METADATA_VALUE_MAX_LENGTH }),
      maximum: t.String({ maxLength: METADATA_VALUE_MAX_LENGTH }),
    }),
  }),
});

const config = {
  cache: { kind: "public", maxAge: 300 },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "auth_plumbing" },
  response: safePublicHandlerResponseSchemasWithStatusText(
    discoveryMetadataSchema,
  ),
} as const satisfies PublicHandlerConfig;

type DiscoveryMetadata = Static<typeof discoveryMetadataSchema>;

const readMetadata = async function* (
  mode: McpMode,
  set: Context["set"],
): SafeHandlerGenerator<DiscoveryMetadata> {
  for (const [key, value] of createMcpMetadataHeaders()) {
    set.headers[key] = value;
  }
  const metadata = yield* Result.await(
    Promise.resolve(Result.try(() => getMcpProtectedResourceMetadata(mode))),
  );
  return Result.ok(metadata);
};

export const readDefaultMetadata = createSafeBoundedPublicHandler(
  config,
  ({ set }) => readMetadata("default", set),
);
export const readAdvancedMetadata = createSafeBoundedPublicHandler(
  config,
  ({ set }) => readMetadata("advanced", set),
);
export const readAnonymizedMetadata = createSafeBoundedPublicHandler(
  config,
  ({ set }) => readMetadata("anonymized", set),
);
export const readDocumentsMetadata = createSafeBoundedPublicHandler(
  config,
  ({ set }) => readMetadata("documents", set),
);
export const readLawMetadata = createSafeBoundedPublicHandler(
  config,
  ({ set }) => readMetadata("law", set),
);
