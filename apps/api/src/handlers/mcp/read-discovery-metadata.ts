import { Result } from "better-result";
import * as v from "valibot";

import type { ResponseSet } from "@/api/http/context";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import type {
  PublicHandlerConfig,
  SafeHandlerGenerator,
} from "@/api/lib/api-handlers";
import { DISCOVERY_METADATA_CACHE_POLICY } from "@/api/lib/security-headers";
import {
  type McpMode,
  STELLA_API_CONTRACT,
  STELLA_MCP_API_CONTRACT_VERSION,
} from "@/api/mcp/constants";
import {
  createMcpMetadataHeaders,
  getMcpProtectedResourceMetadata,
} from "@/api/mcp/metadata";

const URL_MAX_LENGTH = 2048;
const METADATA_VALUE_MAX_LENGTH = 256;
const urlSchema = v.pipe(v.string(), v.maxLength(URL_MAX_LENGTH));
const metadataValueSchema = v.pipe(
  v.string(),
  v.maxLength(METADATA_VALUE_MAX_LENGTH),
);
const discoveryMetadataSchema = v.object({
  resource: urlSchema,
  resource_name: metadataValueSchema,
  resource_logo_uri: urlSchema,
  authorization_servers: v.pipe(v.array(urlSchema), v.maxLength(1)),
  scopes_supported: v.pipe(v.array(metadataValueSchema), v.maxLength(64)),
  bearer_methods_supported: v.pipe(
    v.array(metadataValueSchema),
    v.maxLength(1),
  ),
  stella_contract: v.object({
    protocol: v.literal(STELLA_API_CONTRACT.protocol),
    revision: v.literal(STELLA_API_CONTRACT.revision),
    capabilities: v.object({
      "document-version-upload": v.literal(
        STELLA_API_CONTRACT.capabilities["document-version-upload"],
      ),
      "mcp-v2-transport": v.literal(
        STELLA_API_CONTRACT.capabilities["mcp-v2-transport"],
      ),
    } satisfies Record<keyof typeof STELLA_API_CONTRACT.capabilities, unknown>),
  }),
  stella_compatibility: v.object({
    api_contract_version: v.literal(STELLA_MCP_API_CONTRACT_VERSION),
    cli_version: v.object({
      minimum: metadataValueSchema,
      maximum: metadataValueSchema,
    }),
  }),
});

const config = {
  contract: "patch",
  cache: DISCOVERY_METADATA_CACHE_POLICY,
  // Any origin may read it; the answer carries its own CORS headers.
  cors: "own",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "auth_plumbing" },
  response: safePublicHandlerResponseSchemasWithStatusText(
    discoveryMetadataSchema,
  ),
} as const satisfies PublicHandlerConfig;

type DiscoveryMetadata = v.InferOutput<typeof discoveryMetadataSchema>;

const readMetadata = async function* (
  mode: McpMode,
  set: ResponseSet,
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
