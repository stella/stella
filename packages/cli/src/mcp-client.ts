// The CLI deliberately uses the official MCP client and Streamable HTTP
// transport. This keeps protocol negotiation, JSON-RPC envelopes, errors, and
// resource/tool semantics aligned with the same standard used by hosted MCP
// clients. Stella-specific code below is limited to auth headers and observing
// the exact tools/list response bytes used by the registry trust boundary.
// The bearer token is NEVER logged or embedded in an error message.

import {
  Client,
  ProtocolError,
  SdkError,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type FetchLike,
} from "@modelcontextprotocol/client";
import { Result, TaggedError, type TaggedErrorClass } from "better-result";

import { CLI_MINIMUM_HEADER } from "./cli-version-nudge.js";
import { CLI_VERSION } from "./generated/cli-version.js";
import { MCP_HTTP_PATH } from "./mcp-constants.js";

// Most `tools/call` requests keep the default bounded client ceiling. A
// generated leaf may carry a larger API-owned finite deadline when its bounded
// server work cannot complete within that generic budget. The `tools/list`
// metadata fetch, by contrast, runs
// on the startup refresh path and is awaited before the command executes, so a
// tighter ceiling bounds how long an offline/slow client stalls before it falls
// back to the baked-in tree.
const REQUEST_TIMEOUT_MS = 30_000;
const LIST_REQUEST_TIMEOUT_MS = 10_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One text content block of a `CallToolResult`. */
type ToolResultContent = { type: string; text: string };

/** The `tools/call` result envelope (a success envelope even when isError). */
export type CallToolResult = {
  content: readonly ToolResultContent[];
  isError?: boolean;
};

export type ListToolsResult = { tools: readonly unknown[] };

/** One `content` block of a `resources/read` result. */
type ResourceContent = {
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
const McpClientErrorBase: TaggedErrorClass<"McpClientError"> =
  TaggedError("McpClientError");

export class McpClientError extends McpClientErrorBase<{
  message: string;
  kind: "transport" | "http" | "rpc";
  httpStatus?: number;
  rpcCode?: number;
}> {}

const mcpUrl = (serverUrl: string): string =>
  new URL(MCP_HTTP_PATH, `${serverUrl.replace(/\/$/u, "")}/`).toString();

type ResponseEvidence = {
  rawBody: string;
  headers: Headers;
};

const requestMethod = (init: RequestInit | undefined): string | undefined => {
  const body = init?.body;
  if (typeof body !== "string") {
    return undefined;
  }
  const parsed = Result.try((): unknown => JSON.parse(body));
  if (Result.isError(parsed) || !isRecord(parsed.value)) {
    return undefined;
  }
  return typeof parsed.value["method"] === "string"
    ? parsed.value["method"]
    : undefined;
};

const toClientError = (cause: unknown): McpClientError => {
  if (cause instanceof SdkHttpError) {
    return new McpClientError({
      kind: "http",
      httpStatus: cause.status,
      message: cause.message,
    });
  }
  if (cause instanceof ProtocolError) {
    return new McpClientError({
      kind: "rpc",
      rpcCode: cause.code,
      message: cause.message,
    });
  }
  if (cause instanceof SdkError) {
    return new McpClientError({
      kind: "transport",
      message: cause.message,
    });
  }
  return new McpClientError({
    kind: "transport",
    message: `Request to the MCP server failed: ${
      cause instanceof Error ? cause.message : "network error"
    }`,
  });
};

const runMcpOperation = async <T>({
  serverUrl,
  token,
  timeoutMs,
  observeMethod,
  operation,
}: {
  serverUrl: string;
  token: string;
  timeoutMs?: number;
  observeMethod?: string;
  operation: (client: Client, timeoutMs: number) => Promise<T>;
}): Promise<
  Result<{ value: T; evidence?: ResponseEvidence }, McpClientError>
> => {
  let evidencePromise: Promise<ResponseEvidence | undefined> | undefined;
  const observedFetch: FetchLike = async (input, init) => {
    const response = await fetch(input, init);
    if (observeMethod !== undefined && requestMethod(init) === observeMethod) {
      const headers = new Headers(response.headers);
      evidencePromise = headers
        .get("content-type")
        ?.toLowerCase()
        .includes("application/json")
        ? response
            .clone()
            .text()
            .then((rawBody) => ({ headers, rawBody }))
        : Promise.resolve(undefined);
    }
    return response;
  };
  const transport = new StreamableHTTPClientTransport(
    new URL(mcpUrl(serverUrl)),
    {
      fetch: observedFetch,
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    },
  );
  const client = new Client({ name: "stella-cli", version: CLI_VERSION });
  const result = await Result.tryPromise({
    try: async () => {
      const timeout = timeoutMs ?? REQUEST_TIMEOUT_MS;
      await client.connect(transport, {
        signal: AbortSignal.timeout(timeout),
        timeout,
      });
      try {
        const value = await operation(client, timeout);
        const evidence = await evidencePromise;
        return { value, ...(evidence === undefined ? {} : { evidence }) };
      } finally {
        await client.close();
      }
    },
    catch: (cause) => cause,
  });
  return Result.isError(result)
    ? Result.err(toClientError(result.error))
    : Result.ok(result.value);
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
  timeoutMs,
}: {
  serverUrl: string;
  token: string;
  name: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<Result<CallToolResult, McpClientError>> => {
  const result = await runMcpOperation({
    serverUrl,
    token,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    operation: async (client, timeout) =>
      await client.callTool({ name, arguments: args }, { timeout }),
  });
  if (Result.isError(result)) {
    return Result.err(result.error);
  }
  if (!isCallToolResult(result.value.value)) {
    return Result.err(
      new McpClientError({
        kind: "transport",
        message: "tools/call returned an unexpected result shape",
      }),
    );
  }
  return Result.ok(result.value.value);
};

/** Enumerate the server's tools via `tools/list`. */
export const listTools = async ({
  serverUrl,
  token,
  timeoutMs,
}: {
  serverUrl: string;
  token: string;
  timeoutMs?: number;
}): Promise<Result<ListToolsResult, McpClientError>> => {
  const result = await runMcpOperation({
    serverUrl,
    token,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    operation: async (client, timeout) =>
      await client.listTools(undefined, { timeout }),
  });
  if (Result.isError(result)) {
    return Result.err(result.error);
  }
  return Result.ok({ tools: result.value.value.tools });
};

/** The raw `tools/list` body plus server policy and omission-evidence headers. */
export type RawToolsList = {
  rawBody: string;
  cliMinimum?: string;
  /** Effective scopes echoed by the authenticated server response. */
  grantedScopes?: readonly string[];
  /** Tool names the server attests were omitted solely for missing scope. */
  scopeOmittedTools?: readonly string[];
  /** Tool names the server attests are gated off in this deployment. */
  featureOmittedTools?: readonly string[];
};

/**
 * Fetch the raw `tools/list` response body (spec S5.5). The runtime trust
 * boundary hashes and validates the exact bytes the server returned, so this
 * returns the unparsed text rather than a decoded envelope, plus the advertised
 * minimum-version policy and scope evidence.
 */
const runObservedToolsList = async ({
  serverUrl,
  token,
  timeoutMs = LIST_REQUEST_TIMEOUT_MS,
}: {
  serverUrl: string;
  token: string;
  timeoutMs?: number;
}) =>
  await runMcpOperation({
    serverUrl,
    token,
    timeoutMs,
    observeMethod: "tools/list",
    operation: async (client, timeout) =>
      await client.listTools(undefined, { timeout }),
  });

export const fetchToolsListRaw = async ({
  serverUrl,
  token,
  timeoutMs,
}: {
  serverUrl: string;
  token: string;
  timeoutMs?: number;
}): Promise<Result<RawToolsList, McpClientError>> => {
  const response = await runObservedToolsList({
    serverUrl,
    token,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  if (Result.isError(response)) {
    return Result.err(response.error);
  }
  const evidence = response.value.evidence;
  if (evidence === undefined) {
    return Result.err(
      new McpClientError({
        kind: "transport",
        message: "Official MCP transport did not expose tools/list evidence",
      }),
    );
  }
  const out: RawToolsList = { rawBody: evidence.rawBody };
  const cliMinimum = evidence.headers.get(CLI_MINIMUM_HEADER);
  if (cliMinimum !== null) {
    out.cliMinimum = cliMinimum;
  }
  const scopesHeader = evidence.headers.get(STELLA_SCOPES_HEADER);
  if (scopesHeader !== null) {
    out.grantedScopes =
      scopesHeader.length > 0 ? scopesHeader.split(/\s+/u) : [];
  }
  const scopeOmitted = readAttestedToolNames(
    evidence.headers,
    STELLA_SCOPE_OMITTED_TOOLS_HEADER,
  );
  if (scopeOmitted !== undefined) {
    out.scopeOmittedTools = scopeOmitted;
  }
  const featureOmitted = readAttestedToolNames(
    evidence.headers,
    STELLA_FEATURE_OMITTED_TOOLS_HEADER,
  );
  if (featureOmitted !== undefined) {
    out.featureOmittedTools = featureOmitted;
  }
  return Result.ok(out);
};

/** Response headers the server echoes the authenticated session's identity on. */
const STELLA_ORGANIZATION_HEADER = "x-stella-organization";
const STELLA_SCOPES_HEADER = "x-stella-scopes";
// One header per omission reason. Absent means the server attests nothing (a
// self-hosted deployment older than the evidence contract); present-but-empty
// means it attests that nothing was omitted for that reason.
const STELLA_SCOPE_OMITTED_TOOLS_HEADER = "x-stella-scope-omitted-tools";
const STELLA_FEATURE_OMITTED_TOOLS_HEADER = "x-stella-feature-omitted-tools";

const readAttestedToolNames = (
  headers: Headers,
  header: string,
): readonly string[] | undefined => {
  const raw = headers.get(header);
  if (raw === null) {
    return undefined;
  }
  return raw.length > 0 ? raw.split(/\s+/u) : [];
};

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
  timeoutMs,
}: {
  serverUrl: string;
  token: string;
  timeoutMs?: number;
}): Promise<Result<MachineIdentity, McpClientError>> => {
  const response = await runObservedToolsList({
    serverUrl,
    token,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  if (Result.isError(response)) {
    return Result.err(response.error);
  }
  const headers = response.value.evidence?.headers;
  if (headers === undefined) {
    return Result.err(
      new McpClientError({
        kind: "transport",
        message: "Official MCP transport did not expose identity evidence",
      }),
    );
  }
  const scopesHeader = headers.get(STELLA_SCOPES_HEADER);
  return Result.ok({
    organizationId: headers.get(STELLA_ORGANIZATION_HEADER) ?? "",
    scopes:
      scopesHeader && scopesHeader.length > 0 ? scopesHeader.split(/\s+/u) : [],
  });
};

/** Enumerate the server's static resources via `resources/list`. */
export const listResources = async ({
  serverUrl,
  token,
  timeoutMs,
}: {
  serverUrl: string;
  token: string;
  timeoutMs?: number;
}): Promise<Result<{ resources: readonly unknown[] }, McpClientError>> => {
  const result = await runMcpOperation({
    serverUrl,
    token,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    operation: async (client, timeout) =>
      await client.listResources(undefined, { timeout }),
  });
  if (Result.isError(result)) {
    return Result.err(result.error);
  }
  return Result.ok({ resources: result.value.value.resources });
};

/** Read one resource by URI via `resources/read`. */
export const readResource = async ({
  serverUrl,
  token,
  uri,
  timeoutMs,
}: {
  serverUrl: string;
  token: string;
  uri: string;
  timeoutMs?: number;
}): Promise<Result<ReadResourceResult, McpClientError>> => {
  const result = await runMcpOperation({
    serverUrl,
    token,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    operation: async (client, timeout) =>
      await client.readResource({ uri }, { timeout }),
  });
  if (Result.isError(result)) {
    return Result.err(result.error);
  }
  const contents: ResourceContent[] = [];
  for (const entry of result.value.value.contents) {
    const content: ResourceContent = { uri: entry.uri };
    if (entry.mimeType !== undefined) {
      content.mimeType = entry.mimeType;
    }
    if (!("text" in entry)) {
      return Result.err(
        new McpClientError({
          kind: "transport",
          message: `Binary MCP resource ${entry.uri} is not supported by this CLI`,
        }),
      );
    }
    content.text = entry.text;
    contents.push(content);
  }
  return Result.ok({ contents });
};
