// Minimal hand-rolled JSON-RPC 2.0 client for the stella MCP endpoint (spec 051
// S0). The server runs the SDK transport in stateless JSON mode
// (`enableJsonResponse: true`) with no `initialize` handshake required, so a
// bare `tools/call`/`tools/list` POST works. We do not depend on
// `@modelcontextprotocol/sdk`: the client only ever plumbs these two methods.
//
// The bearer token is NEVER logged or embedded in an error message.

import { Result } from "better-result";

import { CliBaseError } from "./auth/errors.js";
import { MCP_HTTP_PATH } from "./mcp-constants.js";

// `tools/call` can drive a long server operation (e.g. fill_template), so it
// keeps a generous ceiling. The `tools/list` metadata fetch, by contrast, runs
// on the startup refresh path and is awaited before the command executes, so a
// tighter ceiling bounds how long an offline/slow client stalls before it falls
// back to the baked-in tree.
const REQUEST_TIMEOUT_MS = 30_000;
const LIST_REQUEST_TIMEOUT_MS = 10_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One text content block of a `CallToolResult`. */
export type ToolResultContent = { type: string; text: string };

/** The `tools/call` result envelope (a success envelope even when isError). */
export type CallToolResult = {
  content: readonly ToolResultContent[];
  isError?: boolean;
};

/** One tool as returned by `tools/list` (the four wire fields). */
export type ListedTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};

export type ListToolsResult = { tools: readonly unknown[] };

/** One `content` block of a `resources/read` result. */
export type ResourceContent = {
  uri?: string;
  mimeType?: string;
  text?: string;
};

/** The `resources/read` result envelope. */
export type ReadResourceResult = { contents: readonly ResourceContent[] };

/**
 * A transport/HTTP/protocol failure. The three tiers (spec 051 S0/S4) are
 * carried on `kind` so the exit-code mapping can distinguish them:
 * - `transport`: fetch threw / timed out / body was not JSON
 * - `http`: non-2xx HTTP status (401/403/404/5xx)
 * - `rpc`: a JSON-RPC protocol error object (`error.code`)
 *
 * An application-level tool error (`isError: true`, HTTP 200) is NOT this: it
 * comes back as a normal `CallToolResult` for the output layer to surface.
 */
export class McpClientError extends CliBaseError<"McpClientError"> {
  override readonly name = "McpClientError";
  readonly kind: "transport" | "http" | "rpc";
  readonly httpStatus?: number;
  readonly rpcCode?: number;

  constructor(props: {
    message: string;
    kind: "transport" | "http" | "rpc";
    httpStatus?: number;
    rpcCode?: number;
  }) {
    super("McpClientError", props.message);
    this.kind = props.kind;
    if (props.httpStatus !== undefined) {
      this.httpStatus = props.httpStatus;
    }
    if (props.rpcCode !== undefined) {
      this.rpcCode = props.rpcCode;
    }
  }
}

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
};

const mcpUrl = (serverUrl: string): string =>
  new URL(MCP_HTTP_PATH, `${serverUrl.replace(/\/$/u, "")}/`).toString();

const callRpc = async ({
  serverUrl,
  token,
  method,
  params,
}: {
  serverUrl: string;
  token: string;
  method: string;
  params: Record<string, unknown>;
}): Promise<Result<unknown, McpClientError>> => {
  const body: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method, params };

  const response = await Result.tryPromise({
    try: async () =>
      await fetch(mcpUrl(serverUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Both required or the streamable-HTTP transport answers 406.
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(response)) {
    return Result.err(
      new McpClientError({
        kind: "transport",
        message: `Request to the MCP server failed: ${
          response.error instanceof Error
            ? response.error.message
            : "network error"
        }`,
      }),
    );
  }

  const httpResponse = response.value;
  const rawText = await Result.tryPromise({
    try: async () => await httpResponse.text(),
    catch: (cause) => cause,
  });
  const text = Result.isOk(rawText) ? rawText.value : "";

  if (!httpResponse.ok) {
    return Result.err(
      new McpClientError({
        kind: "http",
        httpStatus: httpResponse.status,
        message: `MCP server returned HTTP ${httpResponse.status}${
          text ? `: ${text.slice(0, 500)}` : ""
        }`,
      }),
    );
  }

  const parsed = Result.try((): unknown => JSON.parse(text));
  if (Result.isError(parsed)) {
    return Result.err(
      new McpClientError({
        kind: "transport",
        message: "MCP server returned a non-JSON response body",
      }),
    );
  }

  const envelope = parsed.value;
  if (!isRecord(envelope)) {
    return Result.err(
      new McpClientError({
        kind: "transport",
        message: "MCP server returned an unexpected response envelope",
      }),
    );
  }

  const errorField = envelope["error"];
  if (isRecord(errorField)) {
    const rawCode = errorField["code"];
    const code = typeof rawCode === "number" ? rawCode : undefined;
    const rawMessage = errorField["message"];
    const message =
      typeof rawMessage === "string" ? rawMessage : "MCP protocol error";
    return Result.err(
      new McpClientError({
        kind: "rpc",
        ...(code === undefined ? {} : { rpcCode: code }),
        message,
      }),
    );
  }

  if (!("result" in envelope)) {
    return Result.err(
      new McpClientError({
        kind: "transport",
        message: "MCP response envelope had neither result nor error",
      }),
    );
  }

  return Result.ok(envelope["result"]);
};

const isCallToolResult = (value: unknown): value is CallToolResult =>
  typeof value === "object" &&
  value !== null &&
  "content" in value &&
  Array.isArray(value.content);

/** Invoke a tool via `tools/call`. `isError:true` results come back as success. */
export const callTool = async ({
  serverUrl,
  token,
  name,
  args,
}: {
  serverUrl: string;
  token: string;
  name: string;
  args: Record<string, unknown>;
}): Promise<Result<CallToolResult, McpClientError>> => {
  const result = await callRpc({
    serverUrl,
    token,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (Result.isError(result)) {
    return Result.err(result.error);
  }
  if (!isCallToolResult(result.value)) {
    return Result.err(
      new McpClientError({
        kind: "transport",
        message: "tools/call returned an unexpected result shape",
      }),
    );
  }
  return Result.ok(result.value);
};

/** Enumerate the server's tools via `tools/list`. */
export const listTools = async ({
  serverUrl,
  token,
}: {
  serverUrl: string;
  token: string;
}): Promise<Result<ListToolsResult, McpClientError>> => {
  const result = await callRpc({
    serverUrl,
    token,
    method: "tools/list",
    params: {},
  });
  if (Result.isError(result)) {
    return Result.err(result.error);
  }
  const value = result.value;
  if (!isRecord(value) || !Array.isArray(value["tools"])) {
    return Result.err(
      new McpClientError({
        kind: "transport",
        message: "tools/list returned an unexpected result shape",
      }),
    );
  }
  return Result.ok({ tools: value["tools"] });
};

/** Header names carrying the advertised/minimum CLI version (spec 051 addendum). */
const CLI_LATEST_HEADER = "x-stella-cli-latest";
const CLI_MINIMUM_HEADER = "x-stella-cli-minimum";

/** The raw `tools/list` body plus the CLI-version headers riding on it. */
export type RawToolsList = {
  rawBody: string;
  cliLatest?: string;
  cliMinimum?: string;
};

/**
 * Fetch the raw `tools/list` response body (spec S5.5). The runtime trust
 * boundary hashes and validates the exact bytes the server returned, so this
 * returns the unparsed text rather than a decoded envelope, plus the advertised
 * CLI-version headers (spec 051 addendum) for the update nudge.
 */
export const fetchToolsListRaw = async ({
  serverUrl,
  token,
}: {
  serverUrl: string;
  token: string;
}): Promise<Result<RawToolsList, McpClientError>> => {
  const body: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  };
  const response = await Result.tryPromise({
    try: async () =>
      await fetch(mcpUrl(serverUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LIST_REQUEST_TIMEOUT_MS),
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(response)) {
    return Result.err(
      new McpClientError({
        kind: "transport",
        message: `Request to the MCP server failed: ${
          response.error instanceof Error
            ? response.error.message
            : "network error"
        }`,
      }),
    );
  }
  const httpResponse = response.value;
  if (!httpResponse.ok) {
    return Result.err(
      new McpClientError({
        kind: "http",
        httpStatus: httpResponse.status,
        message: `MCP server returned HTTP ${httpResponse.status}`,
      }),
    );
  }
  const rawText = await Result.tryPromise({
    try: async () => await httpResponse.text(),
    catch: (cause) => cause,
  });
  const text = Result.isOk(rawText) ? rawText.value : "";
  const out: RawToolsList = { rawBody: text };
  const cliLatest = httpResponse.headers.get(CLI_LATEST_HEADER);
  if (cliLatest !== null) {
    out.cliLatest = cliLatest;
  }
  const cliMinimum = httpResponse.headers.get(CLI_MINIMUM_HEADER);
  if (cliMinimum !== null) {
    out.cliMinimum = cliMinimum;
  }
  return Result.ok(out);
};

/** Response headers the server echoes the authenticated session's identity on. */
const STELLA_ORGANIZATION_HEADER = "x-stella-organization";
const STELLA_SCOPES_HEADER = "x-stella-scopes";

/** The org + granted scopes a credential resolves to, per the server. */
export type MachineIdentity = {
  organizationId: string;
  scopes: readonly string[];
};

/**
 * Resolve the identity a bearer credential (machine API key or access token)
 * maps to, by making one real authenticated round-trip (`tools/list`) and
 * reading the identity headers the server echoes on it. An invalid/expired
 * credential fails here as an `http` 401/403 error, so `stella auth whoami`
 * confirms auth rather than echoing static text. The org/scope headers are
 * always present on an authenticated response; a server too old to send them
 * yields an empty identity the caller reports as unknown.
 */
export const fetchMachineIdentity = async ({
  serverUrl,
  token,
}: {
  serverUrl: string;
  token: string;
}): Promise<Result<MachineIdentity, McpClientError>> => {
  const body: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  };
  const response = await Result.tryPromise({
    try: async () =>
      await fetch(mcpUrl(serverUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LIST_REQUEST_TIMEOUT_MS),
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(response)) {
    return Result.err(
      new McpClientError({
        kind: "transport",
        message: `Request to the MCP server failed: ${
          response.error instanceof Error
            ? response.error.message
            : "network error"
        }`,
      }),
    );
  }
  const httpResponse = response.value;
  if (!httpResponse.ok) {
    return Result.err(
      new McpClientError({
        kind: "http",
        httpStatus: httpResponse.status,
        message: `MCP server returned HTTP ${httpResponse.status}`,
      }),
    );
  }
  const scopesHeader = httpResponse.headers.get(STELLA_SCOPES_HEADER);
  return Result.ok({
    organizationId: httpResponse.headers.get(STELLA_ORGANIZATION_HEADER) ?? "",
    scopes:
      scopesHeader && scopesHeader.length > 0 ? scopesHeader.split(/\s+/u) : [],
  });
};

/** Enumerate the server's static resources via `resources/list`. */
export const listResources = async ({
  serverUrl,
  token,
}: {
  serverUrl: string;
  token: string;
}): Promise<Result<{ resources: readonly unknown[] }, McpClientError>> => {
  const result = await callRpc({
    serverUrl,
    token,
    method: "resources/list",
    params: {},
  });
  if (Result.isError(result)) {
    return Result.err(result.error);
  }
  const value = result.value;
  if (!isRecord(value) || !Array.isArray(value["resources"])) {
    return Result.err(
      new McpClientError({
        kind: "transport",
        message: "resources/list returned an unexpected result shape",
      }),
    );
  }
  return Result.ok({ resources: value["resources"] });
};

/** Read one resource by URI via `resources/read`. */
export const readResource = async ({
  serverUrl,
  token,
  uri,
}: {
  serverUrl: string;
  token: string;
  uri: string;
}): Promise<Result<ReadResourceResult, McpClientError>> => {
  const result = await callRpc({
    serverUrl,
    token,
    method: "resources/read",
    params: { uri },
  });
  if (Result.isError(result)) {
    return Result.err(result.error);
  }
  const value = result.value;
  if (!isRecord(value) || !Array.isArray(value["contents"])) {
    return Result.err(
      new McpClientError({
        kind: "transport",
        message: "resources/read returned an unexpected result shape",
      }),
    );
  }
  const contents: ResourceContent[] = [];
  for (const entry of value["contents"]) {
    if (isRecord(entry)) {
      const content: ResourceContent = {};
      if (typeof entry["uri"] === "string") {
        content.uri = entry["uri"];
      }
      if (typeof entry["mimeType"] === "string") {
        content.mimeType = entry["mimeType"];
      }
      if (typeof entry["text"] === "string") {
        content.text = entry["text"];
      }
      contents.push(content);
    }
  }
  return Result.ok({ contents });
};
