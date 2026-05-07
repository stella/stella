import { Result, TaggedError } from "better-result";

import { discoverOAuthMetadata } from "@/api/handlers/mcp-connectors/oauth";
import { validateSafeMcpFetchUrl } from "@/api/handlers/mcp-connectors/url-safety";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const PROBE_TIMEOUT_MS = 10_000;

class McpProbeError extends TaggedError("McpProbeError")<{
  message: string;
  cause?: unknown;
}>() {}

export type McpProbeResult =
  | {
      authType: "oauth2";
      authorizationServerUrl: string;
      resourceUrl: string;
      scopes: string[];
    }
  | { authType: "bearer" }
  | { authType: "none" };

export const probeMcpServer = async (
  rawUrl: string,
): Promise<Result<McpProbeResult, McpProbeError>> => {
  const safeUrl = await validateSafeMcpFetchUrl(rawUrl);
  if (Result.isError(safeUrl)) {
    return Result.err(
      new McpProbeError({
        message: safeUrl.error.message,
        cause: safeUrl.error,
      }),
    );
  }
  const url = safeUrl.value;

  const oauth = await discoverOAuthMetadata(url.toString());
  if (Result.isOk(oauth)) {
    return Result.ok({
      authType: "oauth2" as const,
      authorizationServerUrl: oauth.value.authorizationServer.issuer,
      resourceUrl: oauth.value.protectedResource.resource,
      scopes: oauth.value.protectedResource.scopes_supported ?? [],
    });
  }

  const anonymous = await Result.tryPromise({
    try: async () =>
      await fetch(url, {
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: {
              name: "stella-probe",
              version: "0.0.0",
            },
          },
        }),
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      }),
    catch: (cause) =>
      new McpProbeError({
        message: "MCP server could not be reached",
        cause,
      }),
  });

  if (Result.isError(anonymous)) {
    return Result.err(anonymous.error);
  }

  if (anonymous.value.status === 401) {
    return Result.ok({ authType: "bearer" as const });
  }

  if (anonymous.value.ok) {
    return Result.ok({ authType: "none" as const });
  }

  return Result.err(
    new McpProbeError({
      message: `MCP server probe failed with HTTP ${anonymous.value.status}`,
    }),
  );
};
