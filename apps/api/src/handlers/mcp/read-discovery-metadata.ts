import { Result } from "better-result";
import type { Context } from "elysia";

import {
  ACCOUNT_ACCESS,
  createSafePublicHandler,
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

const config = {
  cache: { kind: "public", maxAge: 300 },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "auth_plumbing" },
} as const satisfies PublicHandlerConfig;

type DiscoveryMetadata = ReturnType<typeof getMcpProtectedResourceMetadata>;

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

export const readDefaultMetadata = createSafePublicHandler(config, ({ set }) =>
  readMetadata("default", set),
);
export const readAnonymizedMetadata = createSafePublicHandler(
  config,
  ({ set }) => readMetadata("anonymized", set),
);
export const readDocumentsMetadata = createSafePublicHandler(
  config,
  ({ set }) => readMetadata("documents", set),
);
export const readLawMetadata = createSafePublicHandler(config, ({ set }) =>
  readMetadata("law", set),
);
