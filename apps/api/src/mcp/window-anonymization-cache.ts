import { Result } from "better-result";

import { createSha256 } from "@stll/sha256/bun";

import { createWindowReadCache } from "@/api/lib/files/window-read-cache";
import { LIMITS } from "@/api/lib/limits";
import { recordReadWork } from "@/api/lib/observability/request-work";
import type { McpRequestContext } from "@/api/mcp/context";

// Only emitted fields are retained; the reversible redaction map is never kept.
export const windowAnonymizationCache = createWindowReadCache<
  readonly string[]
>({
  maxBytes: LIMITS.mcpWindowAnonymizationCacheMaxBytes,
  sizeOf: (fields) =>
    fields.reduce((bytes, field) => bytes + field.length * 2, 0),
});

type CachedAnonymizationOptions<TError> = {
  context: McpRequestContext;
  workspaceId: string;
  source: unknown;
  anonymize: () => Promise<Result<readonly string[], TError>>;
};

/** Internal callers without an authenticated transport credential read through.
 * MCP uses a stateless transport: the bearer credential identifies the session.
 * Catalogs and complete fields form the source identity, so editing either
 * policy or document invalidates the value even within an active session. */
export const anonymizeWindowFields = async <TError>({
  context,
  workspaceId,
  source,
  anonymize,
}: CachedAnonymizationOptions<TError>): Promise<
  Result<readonly string[], TError>
> => {
  const sessionId = context.request?.headers.get("mcp-session-id");
  const credential = context.request?.headers.get("authorization");
  if (!credential) {
    return await anonymize();
  }
  const key = createSha256()
    .update(credential)
    .update("\0")
    .update(
      JSON.stringify([
        context.organizationId,
        context.userId,
        workspaceId,
        sessionId,
        source,
      ]),
    )
    .digest("hex");
  const cached = windowAnonymizationCache.get(key);
  if (cached !== undefined) {
    recordReadWork("cacheHits");
    return Result.ok(cached);
  }
  const result = await anonymize();
  if (Result.isOk(result)) {
    windowAnonymizationCache.set(key, Object.freeze([...result.value]));
  }
  return result;
};
