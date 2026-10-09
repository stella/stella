/** Deployed MCP journeys. Diagnostics contain assertions, never response bodies.
 * Full mode registers a client; frequent mode uses existing client metadata.
 * Staging mints credentials from its smoke session and revokes them each run.
 */
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  LATEST_PROTOCOL_VERSION,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import type { CallToolRequestParams } from "@modelcontextprotocol/server";
import { Result, TaggedError } from "better-result";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { createHash, randomBytes } from "node:crypto";
import * as v from "valibot";

import { MCP_DEFAULT_RESOURCE_SCOPES, MCP_HTTP_PATH } from "@stll/api-contract";
import {
  DESKTOP_ACCOUNT_POLICY,
  DESKTOP_ACCOUNT_PROTOCOL_HEADER,
} from "@stll/api-contract/desktop-registry";
import { CLI_CLIENT_METADATA_PATH } from "@stll/cli/client-metadata-document";
import { fetchWithTimeout } from "@stll/fetch";
import { DAY_IN_MS, Temporal } from "@stll/time";

import { SAMPLE_MATTERS } from "@/api/lib/review-organization/sample-data";
import { MCP_ERROR_CODES } from "@/api/mcp/error-codes";
import { MCP_DISCOVERY_PATH } from "@/api/mcp/resource-policy-contract";
import { MCP_NOTIFICATION_KEEP_ALIVE_MS } from "@/api/mcp/transport-contract";

import { MCP_CANARY_JOURNEY_CREDENTIALS } from "./mcp-canary-credentials";

export { MCP_CANARY_JOURNEY_CREDENTIALS } from "./mcp-canary-credentials";

const PROBE_TIMEOUT_MS = MCP_NOTIFICATION_KEEP_ALIVE_MS * 4;
const STREAM_OPEN_OBSERVATION_MS = 100;
const SSE_CONTENT_TYPE = "text/event-stream";
const CANARY_CLIENT_NAME = "stella-mcp-canary";
const MODERN_PROTOCOL_VERSION = "2026-07-28";

const PROBE_STATUS = {
  failed: "failed",
  warned: "warned",
  passed: "passed",
  skipped: "skipped",
  notApplicable: "not_applicable",
} as const;

type ProbeStatus = (typeof PROBE_STATUS)[keyof typeof PROBE_STATUS];

type ProbeResult = {
  name: string;
  status: ProbeStatus;
  /** Never carries a response body: only the assertion that decided it. */
  detail: string;
  reason?: "no_prod_browser_session";
};

const passed = (name: string, detail: string): ProbeResult => ({
  name,
  status: PROBE_STATUS.passed,
  detail,
});

const failed = (name: string, detail: string): ProbeResult => ({
  name,
  status: PROBE_STATUS.failed,
  detail,
});

const describeProbeFailure = (error: unknown): string => {
  if (error instanceof DOMException) {
    if (error.name === "TimeoutError") {
      return `request timed out after ${String(PROBE_TIMEOUT_MS)} ms`;
    }
    if (error.name === "AbortError") {
      return "request was aborted";
    }
    return "request failed (DOMException)";
  }
  if (error instanceof TypeError) {
    return "network request failed";
  }
  return `probe threw ${error instanceof Error ? error.constructor.name : "an unknown error"}`;
};

/** Convert every transport exception into a named, credential-safe result. */
export const runNamedProbe = async (
  name: string,
  operation: () => Promise<ProbeResult>,
): Promise<ProbeResult> => {
  try {
    return await operation();
  } catch (error) {
    return failed(name, describeProbeFailure(error));
  }
};

const skipped = (name: string, detail: string): ProbeResult => ({
  name,
  status: PROBE_STATUS.skipped,
  detail,
});

const mediaType = (contentType: string | null): string =>
  contentType?.split(";").at(0)?.trim().toLowerCase() ?? "";

const protectedResourceMetadataSchema = v.object({
  authorization_servers: v.pipe(v.array(v.string()), v.minLength(1)),
  resource: v.pipe(v.string(), v.minLength(1)),
});

const jsonRpcResultSchema = v.object({
  jsonrpc: v.literal("2.0"),
  result: v.record(v.string(), v.unknown()),
});

const initializeResultSchema = v.object({
  protocolVersion: v.pipe(v.string(), v.minLength(1)),
  serverInfo: v.object({ name: v.pipe(v.string(), v.minLength(1)) }),
});

const toolsListResultSchema = v.object({
  tools: v.pipe(
    v.array(v.object({ name: v.pipe(v.string(), v.minLength(1)) })),
    v.minLength(1),
  ),
});

type ProbeResponse = {
  allow: string | null;
  body: unknown;
  contentType: string | null;
  status: number;
  wwwAuthenticate: string | null;
};

/** One name per probe, so a skip report cannot drift from what runs. */
const PROBE_NAMES = {
  discovery: `GET ${MCP_DISCOVERY_PATH}`,
  initialize: `POST ${MCP_HTTP_PATH} (legacy initialize)`,
  stream: `GET ${MCP_HTTP_PATH} (notification stream)`,
  toolsList: `POST ${MCP_HTTP_PATH} (modern tools/list)`,
  toolCall: `POST ${MCP_HTTP_PATH} (search_case_law)`,
  unauthenticated: `POST ${MCP_HTTP_PATH} (no credential)`,
} as const;

/**
 * The endpoint advertises its authorization server here. A client that cannot
 * read this never reaches the consent screen, so a broken discovery document
 * fails the whole connector before any token exists.
 */
export const evaluateDiscovery = ({
  body,
  status,
}: Pick<ProbeResponse, "body" | "status">): ProbeResult => {
  const name = PROBE_NAMES.discovery;
  if (status !== 200) {
    return failed(name, `${String(status)} (expected 200)`);
  }
  if (!v.is(protectedResourceMetadataSchema, body)) {
    return failed(name, "200 with no resource + authorization_servers pair");
  }
  return passed(name, "200 with a well-formed metadata document");
};

/**
 * An unauthenticated request must answer 401 *and* carry `WWW-Authenticate`:
 * that header is what points a client at the authorization server. Losing it
 * strands every new connector at sign-in while the endpoint looks reachable.
 */
export const evaluateUnauthenticated = ({
  status,
  wwwAuthenticate,
}: Pick<ProbeResponse, "status" | "wwwAuthenticate">): ProbeResult => {
  const name = PROBE_NAMES.unauthenticated;
  if (status !== 401) {
    return failed(name, `${String(status)} (expected 401)`);
  }
  if (!wwwAuthenticate) {
    return failed(name, "401 without a WWW-Authenticate challenge");
  }
  return passed(name, "401 with an authorization-server challenge");
};

/**
 * ChatGPT opens this optional channel before it calls tools and treats a 405 as
 * a dead connector. Headers are only the first half of the contract: the caller
 * also observes the body briefly and fails if it completes or errors instead of
 * remaining open as a notification channel.
 */
export const evaluateStreamAvailability = ({
  contentType,
  status,
}: Pick<ProbeResponse, "contentType" | "status">): ProbeResult => {
  const name = PROBE_NAMES.stream;
  if (status !== 200) {
    return failed(name, `${String(status)} (expected 200)`);
  }
  if (mediaType(contentType) !== SSE_CONTENT_TYPE) {
    return failed(name, `200 ${contentType ?? "without a content type"}`);
  }
  return passed(name, "200 with an authenticated notification stream");
};

const jsonRpcResult = (body: unknown): Record<string, unknown> | undefined =>
  v.is(jsonRpcResultSchema, body) ? body.result : undefined;

/** A JSON-RPC error rides inside a 200, so the status alone proves nothing. */
export const evaluateInitialize = ({
  body,
  status,
}: Pick<ProbeResponse, "body" | "status">): ProbeResult => {
  const name = PROBE_NAMES.initialize;
  if (status !== 200) {
    return failed(name, `${String(status)} (expected 200)`);
  }
  const result = jsonRpcResult(body);
  if (!result) {
    return failed(name, "200 carrying no JSON-RPC result");
  }
  if (!v.is(initializeResultSchema, result)) {
    return failed(name, "200 with no protocolVersion + serverInfo pair");
  }
  return passed(name, "200 with a negotiated session");
};

/**
 * An empty tool list is the shape a scope or gateway regression takes: the
 * session negotiates, then the client finds nothing to call.
 */
export const evaluateToolsList = ({
  body,
  status,
}: Pick<ProbeResponse, "body" | "status">): ProbeResult => {
  const name = PROBE_NAMES.toolsList;
  if (status !== 200) {
    return failed(name, `${String(status)} (expected 200)`);
  }
  const result = jsonRpcResult(body);
  if (!result) {
    return failed(name, "200 carrying no JSON-RPC result");
  }
  if (!v.is(toolsListResultSchema, result)) {
    return failed(name, "200 with an empty or malformed tool list");
  }
  return passed(name, `200 with ${String(result.tools.length)} tools`);
};

const readProbeResponse = async (
  response: Response,
): Promise<ProbeResponse> => {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }

  return {
    allow: response.headers.get("Allow"),
    body,
    contentType: response.headers.get("content-type"),
    status: response.status,
    wwwAuthenticate: response.headers.get("WWW-Authenticate"),
  };
};

type JsonRpcCall = {
  baseUrl: string;
  era: "legacy" | "modern";
  id: number;
  token: string;
} & (
  | { method: "tools/call"; params: CallToolRequestParams }
  | { method: "initialize" | "tools/list"; params: Record<string, unknown> }
);

export const createJsonRpcRequest = ({
  baseUrl,
  era,
  id,
  method,
  params,
  token,
}: JsonRpcCall): Request => {
  const protocolVersion =
    era === "modern" ? MODERN_PROTOCOL_VERSION : LATEST_PROTOCOL_VERSION;
  const requestParams =
    era === "modern"
      ? {
          ...params,
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: {
              name: CANARY_CLIENT_NAME,
              version: "1.0.0",
            },
            [PROTOCOL_VERSION_META_KEY]: protocolVersion,
          },
        }
      : params;

  return new Request(new URL(MCP_HTTP_PATH, baseUrl).toString(), {
    body: JSON.stringify({
      id,
      jsonrpc: "2.0",
      method,
      params: requestParams,
    }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(era === "modern" ? { "mcp-method": method } : {}),
      ...(era === "modern" && method === "tools/call"
        ? { "mcp-name": params.name }
        : {}),
      "mcp-protocol-version": protocolVersion,
    },
    method: "POST",
  });
};

class CanaryTargetError extends TaggedError("CanaryTargetError")<{
  message: string;
}> {}

type DeploymentFetcherOptions = {
  baseUrl: string;
  /** First-party app origin the advertised OAuth endpoints may live on. */
  appUrl?: string | undefined;
  edgeHeaderName?: string | undefined;
  edgeHeaderValue?: string | undefined;
};

// Redirects are never followed: neither bearer keys nor the staging edge
// credential may travel to a Location supplied by a remote response.
export const createDeploymentFetcher =
  (
    {
      baseUrl,
      appUrl,
      edgeHeaderName,
      edgeHeaderValue,
    }: DeploymentFetcherOptions,
    fetcher: CanaryFetcher = fetchWithTimeout,
  ): CanaryFetcher =>
  async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const allowedOrigins = new Set([new URL(baseUrl).origin]);
    if (appUrl) {
      allowedOrigins.add(new URL(appUrl).origin);
    }
    if (!allowedOrigins.has(url.origin)) {
      throw new CanaryTargetError({
        message: "Canary target must remain on the configured origin",
      });
    }
    const headers = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    for (const [key, value] of new Headers(init.headers)) {
      headers.set(key, value);
    }
    if (edgeHeaderName && edgeHeaderValue) {
      headers.set(edgeHeaderName, edgeHeaderValue);
    }
    return await fetcher(input, { ...init, headers, redirect: "manual" });
  };

const deploymentFetcher: CanaryFetcher = async (input, init) =>
  await createDeploymentFetcher({
    baseUrl:
      process.env["MCP_CANARY_BASE_URL"] ??
      new URL(input instanceof Request ? input.url : input).origin,
    appUrl: process.env["MCP_CANARY_FRONTEND_URL"],
    edgeHeaderName: process.env["E2E_EDGE_HEADER_NAME"],
    edgeHeaderValue: process.env["E2E_EDGE_HEADER_VALUE"],
  })(input, init);

const postJsonRpc = async (
  call: JsonRpcCall,
  fetcher: CanaryFetcher = deploymentFetcher,
): Promise<ProbeResponse> =>
  await readProbeResponse(
    await fetcher(createJsonRpcRequest(call), {
      timeout: { type: "idle", ms: PROBE_TIMEOUT_MS },
    }),
  );

const runPublicProbes = async (baseUrl: string): Promise<ProbeResult[]> =>
  await Promise.all([
    runNamedProbe(PROBE_NAMES.discovery, async () =>
      evaluateDiscovery(
        await readProbeResponse(
          await deploymentFetcher(new URL(MCP_DISCOVERY_PATH, baseUrl), {
            headers: { accept: "application/json" },
            method: "GET",
            timeout: { type: "idle", ms: PROBE_TIMEOUT_MS },
          }),
        ),
      ),
    ),
    runNamedProbe(PROBE_NAMES.unauthenticated, async () =>
      evaluateUnauthenticated(
        await readProbeResponse(
          await deploymentFetcher(new URL(MCP_HTTP_PATH, baseUrl), {
            body: JSON.stringify({
              id: 1,
              jsonrpc: "2.0",
              method: "tools/list",
            }),
            headers: {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
            },
            method: "POST",
            timeout: { type: "idle", ms: PROBE_TIMEOUT_MS },
          }),
        ),
      ),
    ),
  ]);

export type CanaryTarget = { baseUrl: string; token: string };
export type CanaryFetcher = typeof fetchWithTimeout;

type StreamObservation = "cancel_failed" | "closed" | "open" | "read_failed";

/**
 * Distinguish a genuinely open event channel from a 200 response whose body was
 * already truncated. A pending read at the deadline is the normal idle-stream
 * case. If frames arrive during the window, keep reading so a frame followed by
 * immediate EOF still fails rather than masquerading as a live channel.
 */
const inspectNotificationStream = async (
  body: ReadableStream<Uint8Array>,
): Promise<StreamObservation> => {
  const reader = body.getReader();
  try {
    const deadline =
      Temporal.Now.instant().epochMilliseconds + STREAM_OPEN_OBSERVATION_MS;
    const observeUntilDeadline = async (): Promise<StreamObservation> => {
      const remainingMs = deadline - Temporal.Now.instant().epochMilliseconds;
      if (remainingMs <= 0) {
        return "open";
      }
      const readObservation = await Promise.race([
        reader.read().then(
          ({ done }) => (done ? ("closed" as const) : ("frame" as const)),
          (error: unknown) => {
            console.error(
              `[mcp-canary] stream read failed: ${describeProbeFailure(error)}`,
            );
            return "read_failed" as const;
          },
        ),
        Bun.sleep(remainingMs).then(() => "open" as const),
      ]);

      // Reads stay sequential: a frame can be followed immediately by EOF,
      // which is the truncation this bounded observation is meant to catch.
      return readObservation === "frame"
        ? observeUntilDeadline()
        : readObservation;
    };

    const observation = await observeUntilDeadline();
    try {
      await reader.cancel();
    } catch {
      return "cancel_failed";
    }
    return observation;
  } finally {
    reader.releaseLock();
  }
};

export const runAuthenticatedStreamProbe = async (
  { baseUrl, token }: CanaryTarget,
  fetcher: CanaryFetcher = deploymentFetcher,
): Promise<ProbeResult> => {
  const response = await fetcher(new URL(MCP_HTTP_PATH, baseUrl), {
    headers: {
      accept: SSE_CONTENT_TYPE,
      authorization: `Bearer ${token}`,
    },
    method: "GET",
    timeout: { type: "idle", ms: PROBE_TIMEOUT_MS },
  });
  const headerResult = evaluateStreamAvailability({
    contentType: response.headers.get("content-type"),
    status: response.status,
  });

  if (headerResult.status !== PROBE_STATUS.passed) {
    try {
      await response.body?.cancel();
    } catch {
      return failed(PROBE_NAMES.stream, "response-body cancellation failed");
    }
    return headerResult;
  }
  if (response.body === null) {
    return failed(PROBE_NAMES.stream, "200 event stream with no response body");
  }

  const observation = await inspectNotificationStream(response.body);
  if (observation === "closed") {
    return failed(PROBE_NAMES.stream, "200 event stream completed immediately");
  }
  if (observation === "read_failed") {
    return failed(PROBE_NAMES.stream, "200 event stream failed while reading");
  }
  if (observation === "cancel_failed") {
    return failed(PROBE_NAMES.stream, "response-body cancellation failed");
  }
  return headerResult;
};

const TOOL_FAILURE_DETAIL_MAX_LENGTH = 200;

const jsonRpcErrorSchema = v.object({
  error: v.object({
    code: v.optional(v.number()),
    message: v.optional(v.string()),
  }),
});

const firstContentText = (result: Record<string, unknown>) => {
  const parsed = v.safeParse(
    v.object({ content: v.array(v.unknown()) }),
    result,
  );
  if (!parsed.success) {
    return undefined;
  }
  const first = v.safeParse(
    v.object({ text: v.string() }),
    parsed.output.content.at(0),
  );
  return first.success ? first.output.text : undefined;
};

/**
 * One line saying why a tool call failed, so a red run names the cause: the
 * HTTP status, the JSON-RPC error, the tool's own error text, or empty content.
 */
export const describeToolCallFailure = ({
  status,
  body,
}: Pick<ProbeResponse, "body" | "status">): string => {
  const reason = (() => {
    if (status !== 200) {
      return `HTTP ${String(status)}`;
    }
    if (v.is(jsonRpcErrorSchema, body)) {
      const { code, message } = body.error;
      return `JSON-RPC error ${code === undefined ? "" : String(code)} ${message ?? ""}`;
    }
    const result = jsonRpcResult(body);
    if (!result) {
      return "no JSON-RPC result";
    }
    if (result["isError"] === true) {
      return `tool error: ${firstContentText(result) ?? "no error text"}`;
    }
    return "result without content";
  })();
  const line = reason.replaceAll(/\s+/gu, " ").trim();
  return line.length > TOOL_FAILURE_DETAIL_MAX_LENGTH
    ? `${line.slice(0, TOOL_FAILURE_DETAIL_MAX_LENGTH)}...`
    : line;
};

export const evaluateToolCall = ({
  status,
  body,
}: Pick<ProbeResponse, "body" | "status">): ProbeResult => {
  const result = jsonRpcResult(body);
  if (
    status !== 200 ||
    !result ||
    result["isError"] === true ||
    !v.is(
      v.object({ content: v.pipe(v.array(v.unknown()), v.minLength(1)) }),
      result,
    )
  ) {
    return failed(
      PROBE_NAMES.toolCall,
      `expected a non-error JSON-RPC tool result with content (${describeToolCallFailure({ status, body })})`,
    );
  }
  return passed(
    PROBE_NAMES.toolCall,
    "read-only case-law search returned content",
  );
};

type AuthenticatedProbe = {
  name: string;
  run: (target: CanaryTarget, fetcher?: CanaryFetcher) => Promise<ProbeResult>;
};

/**
 * The single declaration of what a credentialed run does. Execution and the
 * skip report both read it, so neither can describe a probe the other lacks.
 */
export const AUTHENTICATED_PROBES = [
  {
    name: PROBE_NAMES.toolCall,
    run: async ({ baseUrl, token }, fetcher = deploymentFetcher) =>
      evaluateToolCall(
        await postJsonRpc(
          {
            baseUrl,
            token,
            era: "modern",
            id: 3,
            method: "tools/call",
            params: {
              name: "search_case_law",
              arguments: { queries: ["contract"], country: "CZ", limit: 1 },
            },
          },
          fetcher,
        ),
      ),
  },
  {
    name: PROBE_NAMES.stream,
    run: runAuthenticatedStreamProbe,
  },
  {
    name: PROBE_NAMES.initialize,
    run: async ({ baseUrl, token }, fetcher = deploymentFetcher) =>
      evaluateInitialize(
        await postJsonRpc(
          {
            baseUrl,
            era: "legacy",
            id: 1,
            method: "initialize",
            params: {
              capabilities: {},
              clientInfo: { name: CANARY_CLIENT_NAME, version: "1.0.0" },
              protocolVersion: LATEST_PROTOCOL_VERSION,
            },
            token,
          },
          fetcher,
        ),
      ),
  },
  {
    name: PROBE_NAMES.toolsList,
    run: async ({ baseUrl, token }, fetcher = deploymentFetcher) =>
      evaluateToolsList(
        await postJsonRpc(
          {
            baseUrl,
            era: "modern",
            id: 2,
            method: "tools/list",
            params: {},
            token,
          },
          fetcher,
        ),
      ),
  },
] as const satisfies readonly AuthenticatedProbe[];

// Concurrent because both eras are stateless: neither the legacy initialize
// nor the modern per-request envelope establishes state for another probe.
export const runAuthenticatedProbes = async (
  target: CanaryTarget,
  fetcher: CanaryFetcher = deploymentFetcher,
): Promise<ProbeResult[]> =>
  await Promise.all(
    AUTHENTICATED_PROBES.map(
      async ({ name, run }) =>
        await runNamedProbe(name, async () => await run(target, fetcher)),
    ),
  );

export const summarize = (results: readonly ProbeResult[]) => ({
  failed: results.filter((result) => result.status === PROBE_STATUS.failed)
    .length,
  skipped: results.filter((result) => result.status === PROBE_STATUS.skipped)
    .length,
});

const PROBE_ICONS = {
  [PROBE_STATUS.failed]: "FAIL",
  [PROBE_STATUS.warned]: "WARN",
  [PROBE_STATUS.passed]: "PASS",
  [PROBE_STATUS.skipped]: "SKIP",
  [PROBE_STATUS.notApplicable]: "N/A",
} as const satisfies Record<ProbeStatus, string>;

const authorizationMetadataSchema = v.object({
  authorization_endpoint: v.pipe(v.string(), v.url()),
  token_endpoint: v.pipe(v.string(), v.url()),
  registration_endpoint: v.pipe(v.string(), v.url()),
  code_challenge_methods_supported: v.array(v.string()),
});
export const evaluateAuthorizationMetadata = ({
  body,
  status,
}: Pick<ProbeResponse, "body" | "status">): ProbeResult => {
  if (
    status !== 200 ||
    !v.is(authorizationMetadataSchema, body) ||
    !body.code_challenge_methods_supported.includes("S256")
  ) {
    return failed(
      "authorization server discovery",
      "expected endpoints and PKCE S256 in a 200 metadata document",
    );
  }
  return passed(
    "authorization server discovery",
    "authorize, token, registration endpoints and PKCE S256 advertised",
  );
};

export const LOOPBACK_REDIRECTS = [
  "http://localhost:49152/callback",
  "http://127.0.0.1:49152/callback",
  "http://[::1]:49152/callback",
] as const;
export const CANARY_CLIENT_IDS = [
  "https://claude.ai/oauth/claude-code-client-metadata",
  "https://chatgpt.com/oauth/codex/client.json",
] as const;
const CANARY_SCOPE = MCP_DEFAULT_RESOURCE_SCOPES.filter(
  (scope) => scope === "stella:search" || scope === "stella:read",
).join(" ");

type AuthorizeResponseOptions = {
  response: Response;
  endpoint: string;
  name: string;
  frontendUrl?: string | undefined;
};
export const evaluateAuthorize = ({
  response,
  endpoint,
  name,
  frontendUrl = endpoint,
}: AuthorizeResponseOptions): ProbeResult => {
  const location = response.headers.get("location");
  if (response.status >= 300 && response.status < 400 && location) {
    const target = new URL(location, endpoint);
    if (
      target.origin === new URL(frontendUrl).origin &&
      target.pathname === "/auth" &&
      new URLSearchParams(
        new URLSearchParams(target.hash.slice(1)).get("oauth_query") ?? "",
      ).has("sig")
    ) {
      return passed(name, "redirects to the application sign-in bridge");
    }
  }
  return failed(
    name,
    `${String(response.status)} without the application sign-in redirect`,
  );
};

export const evaluateRegistration = ({
  status,
  body,
}: Pick<ProbeResponse, "body" | "status">): ProbeResult => {
  if (
    (status !== 200 && status !== 201) ||
    !v.is(v.object({ client_id: v.pipe(v.string(), v.nonEmpty()) }), body)
  ) {
    return failed(
      "dynamic client registration",
      "expected a successful registration with client_id",
    );
  }
  return passed(
    "dynamic client registration",
    "registered all loopback redirects",
  );
};

type OAuthJourneyOptions = {
  baseUrl: string;
  mode: "frequent" | "full";
  frontendUrl?: string | undefined;
};
export const runOAuthJourneys = async (
  { baseUrl, mode, frontendUrl }: OAuthJourneyOptions,
  fetcher: CanaryFetcher = deploymentFetcher,
): Promise<ProbeResult[]> => {
  const results: ProbeResult[] = [];
  const clients: string[] = [...CANARY_CLIENT_IDS];
  let endpoint: string | undefined;
  let registrationEndpoint: string | undefined;
  results.push(
    await runNamedProbe("authorization server discovery", async () => {
      const resource = await readProbeResponse(
        await fetcher(new URL(MCP_DISCOVERY_PATH, baseUrl), {
          timeout: { type: "idle", ms: PROBE_TIMEOUT_MS },
        }),
      );
      const discovery = evaluateDiscovery(resource);
      if (
        discovery.status !== "passed" ||
        !v.is(protectedResourceMetadataSchema, resource.body)
      ) {
        return discovery;
      }
      const issuer = resource.body.authorization_servers.at(0);
      if (!issuer) {
        return failed("authorization server discovery", "no issuer advertised");
      }
      const issuerUrl = new URL(issuer);
      const metadataUrl = new URL(
        `/.well-known/oauth-authorization-server${issuerUrl.pathname.replace(/\/$/u, "")}`,
        issuerUrl.origin,
      );
      const metadata = await readProbeResponse(
        await fetcher(metadataUrl, {
          timeout: { type: "idle", ms: PROBE_TIMEOUT_MS },
        }),
      );
      const evaluation = evaluateAuthorizationMetadata(metadata);
      if (
        evaluation.status === "passed" &&
        v.is(authorizationMetadataSchema, metadata.body)
      ) {
        endpoint = metadata.body.authorization_endpoint;
        registrationEndpoint = metadata.body.registration_endpoint;
      }
      return evaluation;
    }),
  );
  if (mode === "full") {
    results.push(
      await runNamedProbe("dynamic client registration", async () => {
        if (!registrationEndpoint) {
          return failed(
            "dynamic client registration",
            "discovery did not supply registration endpoint",
          );
        }
        const registration = await readProbeResponse(
          await fetcher(registrationEndpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            timeout: { type: "idle", ms: PROBE_TIMEOUT_MS },
            body: JSON.stringify({
              client_name: CANARY_CLIENT_NAME,
              redirect_uris: LOOPBACK_REDIRECTS,
              token_endpoint_auth_method: "none",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              scope: CANARY_SCOPE,
            }),
          }),
        );
        const evaluation = evaluateRegistration(registration);
        if (
          evaluation.status === "passed" &&
          v.is(v.object({ client_id: v.string() }), registration.body)
        ) {
          clients.push(registration.body.client_id);
        }
        return evaluation;
      }),
    );
  }
  const authorizationEndpoint = endpoint;
  for (const clientId of clients) {
    for (const redirectUri of LOOPBACK_REDIRECTS) {
      const name = `authorize ${clientId} -> ${redirectUri}`;
      results.push(
        await runNamedProbe(name, async () => {
          if (!authorizationEndpoint) {
            return failed(
              name,
              "discovery did not supply authorization endpoint",
            );
          }
          const url = new URL(authorizationEndpoint);
          const challenge = createHash("sha256")
            .update(randomBytes(32).toString("base64url"))
            .digest("base64url");
          url.search = new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirectUri,
            response_type: "code",
            code_challenge_method: "S256",
            code_challenge: challenge,
            scope: CANARY_SCOPE,
            state: Bun.randomUUIDv7(),
            resource: new URL(MCP_HTTP_PATH, baseUrl).toString(),
          }).toString();
          const response = await fetcher(url, {
            method: "GET",
            redirect: "manual",
            timeout: { type: "idle", ms: PROBE_TIMEOUT_MS },
          });
          const result = evaluateAuthorize({
            response,
            endpoint: authorizationEndpoint,
            name,
            frontendUrl,
          });
          await response.body?.cancel();
          return result;
        }),
      );
    }
  }
  return results;
};

const desktopIdentitySchema = v.object({
  userId: v.pipe(v.string(), v.nonEmpty()),
  organizationId: v.pipe(v.string(), v.nonEmpty()),
});
export const evaluateDesktopRedeem = ({
  status,
  body,
  identity,
}: Pick<ProbeResponse, "body" | "status"> & {
  identity: v.InferOutput<typeof desktopIdentitySchema>;
}): ProbeResult => {
  const schema = v.object({
    status: v.literal("connected"),
    identity: desktopIdentitySchema,
  });
  if (
    status !== 200 ||
    !v.is(schema, body) ||
    body.identity.userId !== identity.userId ||
    body.identity.organizationId !== identity.organizationId
  ) {
    return failed(
      "desktop handoff redeem",
      "expected connected with the existing desktop account identity",
    );
  }
  return passed(
    "desktop handoff redeem",
    "redeemed a handoff using the existing desktop credential",
  );
};
const notApplicable = (name: string, detail: string): ProbeResult => ({
  name,
  status: PROBE_STATUS.notApplicable,
  detail,
});

const STAGING_KEY_NAME = "MCP staging canary";
const STAGING_KEY_PERMISSIONS = { workspace: ["read"] };
const EXPIRY_ALERT_WINDOW_MS = 15 * DAY_IN_MS;

export const evaluateCredentialExpiry = ({
  status,
  body,
  nowMs,
}: Pick<ProbeResponse, "body" | "status"> & { nowMs: number }): ProbeResult => {
  const name = "canary bearer expiry";
  const schema = v.object({
    expiresAt: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
  });
  // The status decides the fix: 404 means the target predates the endpoint,
  // 401 means the key itself was refused, anything else is the deployment.
  if (status === 404) {
    return failed(
      name,
      "HTTP 404: the target does not serve the key expiry endpoint yet",
    );
  }
  if (status === 401) {
    return failed(name, "HTTP 401: the target refused MCP_CANARY_TOKEN");
  }
  if (status !== 200 || !v.is(schema, body)) {
    return failed(
      name,
      `HTTP ${status}: could not inspect the current machine key expiry`,
    );
  }
  if (body.expiresAt === null) {
    return passed(name, "credential has no expiry");
  }
  const remainingMs =
    Temporal.Instant.from(body.expiresAt).epochMilliseconds - nowMs;
  if (remainingMs <= EXPIRY_ALERT_WINDOW_MS) {
    return failed(
      name,
      "key expires within 15 days: rotate MCP_CANARY_TOKEN (14-day notice plus scheduling margin)",
    );
  }
  return passed(name, "credential expiry is more than 15 days away");
};

export const runCredentialExpiryProbe = async (
  { baseUrl, token }: CanaryTarget,
  fetcher: CanaryFetcher = deploymentFetcher,
): Promise<ProbeResult> =>
  evaluateCredentialExpiry({
    ...(await readProbeResponse(
      await fetcher(new URL("/v1/api-keys/current", baseUrl), {
        headers: { authorization: `Bearer ${token}` },
        timeout: { type: "idle", ms: PROBE_TIMEOUT_MS },
      }),
    )),
    nowMs: Temporal.Now.instant().epochMilliseconds,
  });

type DesktopProbeOptions = { baseUrl: string; sessionCookie: string };
export const runDesktopProbe = async (
  { baseUrl, sessionCookie }: DesktopProbeOptions,
  fetcher: CanaryFetcher = deploymentFetcher,
): Promise<ProbeResult[]> => {
  const results: ProbeResult[] = [];
  let desktopKey: string | undefined;
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  const deviceJkt = await calculateJwkThumbprint(jwk, "sha256");
  type DesktopProbeProofOptions = {
    path: string;
    credential?: string;
    nonce?: string;
  };
  const signProof = async ({
    path,
    credential,
    nonce,
  }: DesktopProbeProofOptions) =>
    await new SignJWT({
      htm: "POST",
      htu: new URL(path, baseUrl).toString(),
      ...(credential
        ? { ath: createHash("sha256").update(credential).digest("base64url") }
        : {}),
      ...(nonce ? { nonce } : {}),
    })
      .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk })
      .setIssuedAt()
      .setJti(Bun.randomUUIDv7())
      .sign(privateKey);
  try {
    results.push(
      await runNamedProbe("desktop handoff redeem", async () => {
        const sessionResponse = await readProbeResponse(
          await fetcher(new URL("/api/auth/get-session", baseUrl), {
            headers: { cookie: sessionCookie },
            timeout: { type: "idle", ms: PROBE_TIMEOUT_MS },
          }),
        );
        const schema = v.object({
          user: v.object({ id: v.pipe(v.string(), v.nonEmpty()) }),
          session: v.object({
            activeOrganizationId: v.pipe(v.string(), v.nonEmpty()),
          }),
        });
        if (
          sessionResponse.status !== 200 ||
          !v.is(schema, sessionResponse.body)
        ) {
          return failed(
            "desktop handoff redeem",
            "smoke browser session did not return an account identity",
          );
        }
        const identity = {
          userId: sessionResponse.body.user.id,
          organizationId: sessionResponse.body.session.activeOrganizationId,
        };
        const redeemHandoff = async (key?: string) => {
          const correlationId = Bun.randomUUIDv7();
          const verifier = randomBytes(32).toString("hex");
          const grant = await fetcher(
            new URL("/v1/desktop-registry/grant", baseUrl),
            {
              method: "POST",
              headers: {
                cookie: sessionCookie,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                correlationId,
                deviceJkt,
                verifierHash: createHash("sha256")
                  .update(verifier)
                  .digest("hex"),
              }),
              timeout: { type: "idle", ms: PROBE_TIMEOUT_MS },
            },
          );
          await grant.body?.cancel();
          if (!grant.ok) {
            return { body: undefined, status: grant.status };
          }
          return await readProbeResponse(
            await fetcher(
              new URL("/v1/desktop-registry/redeem-link", baseUrl),
              {
                method: "POST",
                headers: {
                  ...(key ? { authorization: `Bearer ${key}` } : {}),
                  "content-type": "application/json",
                  "user-agent": "stella-desktop",
                  DPoP: await signProof({
                    path: "/v1/desktop-registry/redeem-link",
                    ...(key === undefined ? {} : { credential: key }),
                    nonce: correlationId,
                  }),
                  [DESKTOP_ACCOUNT_PROTOCOL_HEADER]: String(
                    DESKTOP_ACCOUNT_POLICY.linkProtocol,
                  ),
                },
                body: JSON.stringify({
                  correlationId,
                  deviceJkt,
                  verifier,
                  expectedUserId: identity.userId,
                  expectedOrganizationId: identity.organizationId,
                }),
                timeout: { type: "idle", ms: PROBE_TIMEOUT_MS },
              },
            ),
          );
        };
        const minted = await redeemHandoff();
        // Capture a returned key before classifying the rest of the response so
        // malformed success responses still trigger credential cleanup.
        if (
          v.is(v.object({ key: v.pipe(v.string(), v.nonEmpty()) }), minted.body)
        ) {
          desktopKey = minted.body.key;
        }
        if (
          minted.status !== 200 ||
          !desktopKey ||
          !v.is(v.object({ status: v.literal("credential") }), minted.body)
        ) {
          return failed(
            "desktop handoff redeem",
            "could not mint a desktop credential from the smoke browser session",
          );
        }
        return evaluateDesktopRedeem({
          ...(await redeemHandoff(desktopKey)),
          identity,
        });
      }),
    );
  } finally {
    const keyToRevoke = desktopKey;
    if (keyToRevoke) {
      results.push(
        await runNamedProbe("desktop credential cleanup", async () => {
          const response = await readProbeResponse(
            await fetcher(new URL("/v1/desktop-registry/request", baseUrl), {
              method: "POST",
              headers: {
                authorization: `Bearer ${keyToRevoke}`,
                DPoP: await signProof({
                  path: "/v1/desktop-registry/request",
                  credential: keyToRevoke,
                }),
                "user-agent": "stella-desktop",
                "content-type": "application/json",
              },
              body: JSON.stringify({ type: "revoke" }),
              timeout: { type: "idle", ms: PROBE_TIMEOUT_MS },
            }),
          );
          if (
            response.status !== 200 ||
            !v.is(v.object({ revoked: v.literal(true) }), response.body)
          ) {
            return failed(
              "desktop credential cleanup",
              "could not revoke the per-run desktop credential",
            );
          }
          return passed(
            "desktop credential cleanup",
            "per-run desktop key revoked",
          );
        }),
      );
    } else {
      results.push(
        notApplicable(
          "desktop credential cleanup",
          "no desktop credential was returned",
        ),
      );
    }
  }
  return results;
};

type StagingJourneyOptions = {
  baseUrl: string;
  smokeSecret?: string | undefined;
};
export const runStagingCredentialJourneys = async (
  { baseUrl, smokeSecret }: StagingJourneyOptions,
  fetcher: CanaryFetcher = deploymentFetcher,
): Promise<ProbeResult[]> => {
  const bootstrapName = "staging credential bootstrap";
  if (!smokeSecret) {
    return [
      skipped(
        bootstrapName,
        "missing SMOKE_SESSION_SECRET: staging mints its credentials per run",
      ),
      ...AUTHENTICATED_PROBES.map(({ name }) =>
        skipped(name, "no staging smoke session available"),
      ),
      skipped("desktop handoff redeem", "missing SMOKE_SESSION_SECRET"),
    ];
  }
  const results: ProbeResult[] = [];
  let sessionCookie: string | undefined;
  let keyId: string | undefined;
  let token: string | undefined;
  try {
    results.push(
      await runNamedProbe(bootstrapName, async () => {
        const smoke = await readProbeResponse(
          // Mounted at the root, outside the versioned API prefix.
          await fetcher(new URL("/smoke/session", baseUrl), {
            method: "POST",
            headers: { "x-smoke-secret": smokeSecret },
            timeout: { type: "idle", ms: PROBE_TIMEOUT_MS },
          }),
        );
        if (
          smoke.status !== 200 ||
          !v.is(
            v.object({
              cookieName: v.pipe(v.string(), v.nonEmpty()),
              cookieValue: v.pipe(v.string(), v.nonEmpty()),
            }),
            smoke.body,
          )
        ) {
          return failed(
            bootstrapName,
            "could not mint the staging browser session",
          );
        }
        sessionCookie = `${smoke.body.cookieName}=${smoke.body.cookieValue}`;
        const minted = await readProbeResponse(
          await fetcher(new URL("/v1/api-keys/", baseUrl), {
            method: "POST",
            headers: {
              cookie: sessionCookie,
              "content-type": "application/json",
            },
            timeout: { type: "idle", ms: PROBE_TIMEOUT_MS },
            body: JSON.stringify({
              name: STAGING_KEY_NAME,
              scopes: CANARY_SCOPE.split(" "),
              permissions: STAGING_KEY_PERMISSIONS,
              audience: "default",
              expiresInDays: 1,
            }),
          }),
        );
        if (
          v.is(v.object({ id: v.pipe(v.string(), v.nonEmpty()) }), minted.body)
        ) {
          keyId = minted.body.id;
        }
        if (
          minted.status !== 200 ||
          !v.is(
            v.object({ key: v.pipe(v.string(), v.nonEmpty()) }),
            minted.body,
          ) ||
          !keyId
        ) {
          return failed(
            bootstrapName,
            "could not mint the per-run MCP machine key",
          );
        }
        token = minted.body.key;
        return passed(
          bootstrapName,
          "minted a short-lived MCP key using the staging smoke browser session",
        );
      }),
    );
    const mintedToken = token;
    if (mintedToken) {
      results.push(
        ...(await runAuthenticatedProbes(
          { baseUrl, token: mintedToken },
          fetcher,
        )),
      );
    } else {
      results.push(
        ...AUTHENTICATED_PROBES.map(({ name }) =>
          skipped(name, "staging credential bootstrap failed"),
        ),
      );
    }
    const browserCookie = sessionCookie;
    if (browserCookie) {
      results.push(
        ...(await runDesktopProbe(
          { baseUrl, sessionCookie: browserCookie },
          fetcher,
        )),
      );
    } else {
      results.push(
        skipped(
          "desktop handoff redeem",
          "staging smoke browser session unavailable",
        ),
      );
    }
  } finally {
    const idToRevoke = keyId;
    const browserCookie = sessionCookie;
    if (idToRevoke && browserCookie) {
      results.push(
        await runNamedProbe("MCP credential cleanup", async () => {
          const response = await readProbeResponse(
            await fetcher(new URL("/v1/api-keys/revoke", baseUrl), {
              method: "POST",
              headers: {
                cookie: browserCookie,
                "content-type": "application/json",
              },
              timeout: { type: "idle", ms: PROBE_TIMEOUT_MS },
              body: JSON.stringify({ keyId: idToRevoke }),
            }),
          );
          if (
            response.status !== 200 ||
            !v.is(
              v.object({ id: v.literal(idToRevoke), revoked: v.literal(true) }),
              response.body,
            )
          ) {
            return failed(
              "MCP credential cleanup",
              "could not revoke the per-run MCP credential",
            );
          }
          return passed("MCP credential cleanup", "per-run MCP key revoked");
        }),
      );
    } else {
      results.push(
        notApplicable(
          "MCP credential cleanup",
          "no MCP credential id was returned",
        ),
      );
    }
  }
  return results;
};

const REVIEW_KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(MCP_ERROR_CODES);

const REVIEW_JOURNEY_SCOPE = [
  "stella:read",
  "stella:matters_write",
  // Request excluded scopes too: their tools must remain unavailable even
  // when the public client is allowed to request them.
  "stella:admin_read",
  "stella:admin_write",
  "stella:billing_write",
].join(" ");

const REVIEW_FORBIDDEN_TOOLS = [
  "list_audit_log",
  "save_time_entry",
  "delete_time_entry",
] as const;

const reviewJourneyName = (step: string) => `restricted account: ${step}`;

class ReviewJourneyError extends TaggedError("ReviewJourneyError")<{
  message: string;
}> {}

/** Only known machine codes are printable; an arbitrary server string may
 * contain a credential. Response messages and tool content never enter logs.
 */
const reviewEnvelopeCode = (body: unknown): string => {
  const envelope = v.safeParse(
    v.union([
      v.object({
        error: v.object({ code: v.union([v.string(), v.number()]) }),
      }),
      v.object({ error: v.string() }),
      v.object({ code: v.string() }),
    ]),
    body,
  );
  if (!envelope.success) {
    return "none";
  }
  let code: string | number;
  if ("error" in envelope.output) {
    const error = envelope.output.error;
    code = typeof error === "string" ? error : error.code;
  } else {
    code = envelope.output.code;
  }
  if (typeof code === "number") {
    return [-32_700, -32_600, -32_601, -32_602, -32_603].includes(code)
      ? String(code)
      : "unrecognized";
  }
  return REVIEW_KNOWN_ERROR_CODES.has(code) ||
    [
      "invalid_request",
      "invalid_scope",
      "invalid_grant",
      "access_denied",
      "account_access_unavailable",
      "INVALID_EMAIL_OR_PASSWORD",
      "TOO_MANY_REQUESTS",
    ].includes(code)
    ? code
    : "unrecognized";
};

const reviewToolPayload = (body: unknown): unknown => {
  const result = jsonRpcResult(body);
  if (!result || result["isError"] === true) {
    return undefined;
  }
  return result["structuredContent"];
};

const reviewRedirectSchema = v.object({ url: v.pipe(v.string(), v.url()) });
const reviewTaskIdSchema = v.pipe(v.string(), v.uuid());
const reviewTaskListSchema = v.object({
  tasks: v.array(
    v.object({
      id: reviewTaskIdSchema,
      name: v.string(),
      matterId: reviewTaskIdSchema,
    }),
  ),
});

// The canary owns this receiver; only its exact callback URL is fetched, with
// no cookie, password, edge credential or bearer header.
const createReviewCallback = (state: string) => {
  let code: string | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname !== "/callback") {
        return new Response(null, { status: 404 });
      }
      const receivedCode = url.searchParams.get("code");
      if (!receivedCode || url.searchParams.get("state") !== state || code) {
        return new Response(null, { status: 400 });
      }
      code = receivedCode;
      return new Response(null, { status: 204 });
    },
  });
  return {
    redirectUri: `http://127.0.0.1:${String(server.port)}/callback`,
    code: () => code,
    close: async () => await server.stop(true),
  };
};

type ReviewAccountJourneyOptions = {
  baseUrl: string;
  configuredBaseUrl: string;
  frontendUrl?: string | undefined;
  password?: string | undefined;
  email?: string | undefined;
  mode: "full" | "frequent";
};

const createReviewJourneyContext = (
  {
    baseUrl,
    configuredBaseUrl,
    frontendUrl,
    journey = "restricted account",
    scope = REVIEW_JOURNEY_SCOPE,
  }: {
    baseUrl: string;
    configuredBaseUrl: string;
    frontendUrl: string;
    journey?: string;
    scope?: string;
  },
  fetcher: CanaryFetcher,
) => {
  const results: ProbeResult[] = [];
  const cookies = new Map<string, Map<string, string>>();
  // Both origins come from configuration, never discovery or dispatch input.
  // Cookies remain with the origin that set them; redirects are never followed.
  const targetFetch = createDeploymentFetcher(
    {
      baseUrl: configuredBaseUrl,
      appUrl: frontendUrl,
    },
    fetcher,
  );
  const state: {
    step: string;
    lastResponse: Pick<ProbeResponse, "body" | "status"> | undefined;
    callback?: ReturnType<typeof createReviewCallback>;
    token?: string;
    refreshToken?: string;
    createdTaskId?: string;
  } = { step: "sign-in", lastResponse: undefined };

  const reject: (assertion: string) => never = (assertion) => {
    throw new ReviewJourneyError({
      message: `HTTP ${state.lastResponse ? String(state.lastResponse.status) : "unavailable"}; envelope code ${reviewEnvelopeCode(state.lastResponse?.body)}; ${assertion}`,
    });
  };
  const complete = () => {
    results.push(passed(`${journey}: ${state.step}`, "assertions passed"));
  };
  const request = async (
    url: string | URL,
    init: Pick<RequestInit, "body" | "headers" | "method"> = {},
  ) => {
    state.lastResponse = undefined;
    const origin = new URL(url).origin;
    const headers = new Headers(init.headers);
    const requestCookies = cookies.get(origin);
    if (requestCookies && requestCookies.size > 0) {
      headers.set(
        "cookie",
        [...requestCookies].map(([key, value]) => `${key}=${value}`).join("; "),
      );
    }
    headers.set("origin", new URL(frontendUrl).origin);
    const response = await targetFetch(url, {
      ...init,
      headers,
      timeout: { type: "idle", ms: PROBE_TIMEOUT_MS },
    });
    const responseCookies = cookies.get(origin) ?? new Map<string, string>();
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";").at(0);
      const separator = pair?.indexOf("=") ?? -1;
      if (pair && separator > 0) {
        responseCookies.set(
          pair.slice(0, separator),
          pair.slice(separator + 1),
        );
      }
    }
    cookies.set(origin, responseCookies);
    state.lastResponse = await readProbeResponse(response);
    if (state.lastResponse.status !== 200) {
      reject("expected HTTP 200");
    }
    return state.lastResponse.body;
  };
  const rpc = async (call: JsonRpcCall) => {
    state.lastResponse = undefined;
    state.lastResponse = await postJsonRpc(call, targetFetch);
    const result = jsonRpcResult(state.lastResponse.body);
    if (
      state.lastResponse.status !== 200 ||
      !result ||
      result["isError"] === true
    ) {
      // Tool error envelopes live in text content. Parse only for a known code.
      if (result?.["isError"] === true) {
        const text = firstContentText(result);
        const parsed = Result.try((): unknown => JSON.parse(text ?? ""));
        if (parsed.isOk()) {
          state.lastResponse = {
            status: state.lastResponse.status,
            body: parsed.value,
          };
        }
      }
      reject("expected a successful JSON-RPC result");
    }
    return state.lastResponse.body;
  };
  const callTool = async (name: string, args: Record<string, unknown>) => {
    if (!state.token) {
      reject("access token unavailable");
    }
    return reviewToolPayload(
      await rpc({
        baseUrl,
        token: state.token,
        era: "modern",
        id: 3,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    );
  };

  return {
    baseUrl,
    frontendUrl,
    scope,
    results,
    cookies,
    state,
    reject,
    complete,
    request,
    rpc,
    callTool,
  };
};

type ReviewJourneyContext = ReturnType<typeof createReviewJourneyContext>;

const requireReviewToken = (context: ReviewJourneyContext): string => {
  const reject: (assertion: string) => never = context.reject;
  if (!context.state.token) {
    reject("access token unavailable");
  }
  return context.state.token;
};

type ReviewSignInOptions = {
  context: ReviewJourneyContext;
  email: string;
  password: string;
};
const signInReviewAccount = async ({
  context,
  email,
  password,
}: ReviewSignInOptions) => {
  const { frontendUrl, cookies, complete, request } = context;
  const reject: (assertion: string) => never = context.reject;
  // Exactly one password attempt. A failed sign-in aborts the journey; there
  // is no retry and no negative-password probe against the lockout budget.
  const signedIn = await request(
    new URL("/api/auth/sign-in/email", frontendUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      // oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- the sign-in request body itself, sent only to the configured frontend origin; never logged, and step errors never include the body
      body: JSON.stringify({ email, password }),
    },
  );
  if (
    !v.is(
      v.object({ user: v.object({ email: v.literal(email) }) }),
      signedIn,
    ) ||
    (cookies.get(new URL(frontendUrl).origin)?.size ?? 0) === 0
  ) {
    reject("expected the review identity and a session cookie");
  }
  complete();
};

const checkReviewSession = async (
  context: ReviewJourneyContext,
  email: string,
) => {
  const { frontendUrl, state, complete, request } = context;
  const reject: (assertion: string) => never = context.reject;
  state.step = "session";
  const session = await request(new URL("/api/auth/get-session", frontendUrl));
  if (
    !v.is(
      v.object({
        user: v.object({ email: v.literal(email) }),
        session: v.object({
          activeOrganizationId: v.pipe(v.string(), v.nonEmpty()),
        }),
      }),
      session,
    )
  ) {
    reject("expected the review identity with an active organization");
  }
  complete();
};

const discoverReviewOAuth = async (context: ReviewJourneyContext) => {
  const { baseUrl, state, complete, request } = context;
  const reject: (assertion: string) => never = context.reject;
  state.step = "discovery";
  const resource = await request(new URL(MCP_DISCOVERY_PATH, baseUrl));
  if (!v.is(protectedResourceMetadataSchema, resource)) {
    reject("expected protected-resource discovery");
  }
  const advertisedIssuer = resource.authorization_servers.at(0);
  if (!advertisedIssuer) {
    reject("expected an authorization server issuer");
  }
  const issuer = new URL(advertisedIssuer);
  const metadata = await request(
    new URL(
      `/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/$/u, "")}`,
      issuer.origin,
    ),
  );
  if (
    !v.is(authorizationMetadataSchema, metadata) ||
    !metadata.code_challenge_methods_supported.includes("S256")
  ) {
    reject("expected OAuth endpoints and PKCE S256");
  }
  complete();
  return metadata;
};

const authorizeReviewOAuth = async (
  context: ReviewJourneyContext,
  metadata: v.InferOutput<typeof authorizationMetadataSchema>,
) => {
  const { baseUrl, state, complete, request } = context;
  const reject: (assertion: string) => never = context.reject;
  state.step = "authorize";
  const verifier = randomBytes(32).toString("base64url");
  const stateValue = randomBytes(32).toString("base64url");
  state.callback = createReviewCallback(stateValue);
  const clientId = new URL(CLI_CLIENT_METADATA_PATH, baseUrl).toString();
  const authorize = new URL(metadata.authorization_endpoint);
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: state.callback.redirectUri,
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: stateValue,
    scope: context.scope,
    resource: new URL(MCP_HTTP_PATH, baseUrl).toString(),
  }).toString();
  const authorized = await request(authorize, {
    headers: { accept: "application/json" },
  });
  if (!v.is(reviewRedirectSchema, authorized)) {
    reject("expected an OAuth continuation URL");
  }
  complete();
  return {
    callback: state.callback,
    verifier,
    stateValue,
    clientId,
    redirect: new URL(authorized.url),
    tokenEndpoint: metadata.token_endpoint,
  };
};

const consentReviewOAuth = async (
  context: ReviewJourneyContext,
  redirect: URL,
) => {
  const { frontendUrl, state, complete, request } = context;
  const reject: (assertion: string) => never = context.reject;
  if (
    redirect.pathname === "/consent" &&
    redirect.origin === new URL(frontendUrl).origin
  ) {
    state.step = "consent";
    const signedQuery = new URLSearchParams(redirect.hash.slice(1)).get(
      "oauth_query",
    );
    if (!signedQuery) {
      reject("expected signed consent query");
    }
    const consent = await request(
      new URL("/api/auth/oauth2/consent", frontendUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accept: true, oauth_query: signedQuery }),
      },
    );
    if (!v.is(reviewRedirectSchema, consent)) {
      reject("expected consent callback URL");
    }
    complete();
    return new URL(consent.url);
  }
  return redirect;
};

type ReviewCallbackOptions = {
  context: ReviewJourneyContext;
  redirect: URL;
  stateValue: string;
  callback: ReturnType<typeof createReviewCallback>;
};
const captureReviewCallback = async ({
  context,
  redirect,
  stateValue,
  callback,
}: ReviewCallbackOptions) => {
  const { state, complete } = context;
  const reject: (assertion: string) => never = context.reject;
  state.step = "callback";
  const expected = new URL(callback.redirectUri);
  if (
    redirect.origin !== expected.origin ||
    redirect.pathname !== expected.pathname ||
    redirect.searchParams.get("state") !== stateValue ||
    !redirect.searchParams.get("code") ||
    redirect.searchParams.has("error") ||
    redirect.username !== "" ||
    redirect.password !== ""
  ) {
    reject("expected the owned loopback callback and matching state");
  }
  state.lastResponse = undefined;
  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- the canary's own loopback receiver; origin, path and state checked against the issued redirect before this call; no credentials, redirects manual
  const delivered = await fetchWithTimeout(redirect, {
    redirect: "manual",
    timeout: { type: "idle", ms: PROBE_TIMEOUT_MS },
  });
  await delivered.body?.cancel();
  state.lastResponse = { status: delivered.status, body: undefined };
  const code = callback.code();
  if (delivered.status !== 204 || !code) {
    reject("loopback receiver did not capture the authorization code");
  }
  complete();
  return code;
};

type ReviewTokenOptions = {
  context: ReviewJourneyContext;
  authorization: ReviewAuthorization;
  code: string;
};
const exchangeReviewToken = async ({
  context,
  authorization,
  code,
}: ReviewTokenOptions) => {
  const { baseUrl, state, request } = context;
  const reject: (assertion: string) => never = context.reject;
  state.step = "token";
  const exchanged = await request(authorization.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: authorization.clientId,
      redirect_uri: authorization.callback.redirectUri,
      code_verifier: authorization.verifier,
      code,
      resource: new URL(MCP_HTTP_PATH, baseUrl).toString(),
    }).toString(),
  });
  if (
    v.is(
      v.object({ refresh_token: v.pipe(v.string(), v.nonEmpty()) }),
      exchanged,
    )
  ) {
    state.refreshToken = exchanged.refresh_token;
  }
  if (
    !v.is(
      v.object({ access_token: v.pipe(v.string(), v.nonEmpty()) }),
      exchanged,
    )
  ) {
    reject("expected an OAuth access token");
  }
  state.token = exchanged.access_token;
  return exchanged;
};

const initializeReviewMcp = async (
  context: ReviewJourneyContext,
  step = "initialize",
) => {
  const { baseUrl, state, complete, rpc } = context;
  const reject: (assertion: string) => never = context.reject;
  state.step = step;
  const initialized = await rpc({
    baseUrl,
    token: requireReviewToken(context),
    era: "legacy",
    id: 1,
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: CANARY_CLIENT_NAME, version: "1.0.0" },
      protocolVersion: LATEST_PROTOCOL_VERSION,
    },
  });
  if (!v.is(initializeResultSchema, jsonRpcResult(initialized))) {
    reject("expected a negotiated MCP session");
  }
  complete();
};

const listReviewTools = async (context: ReviewJourneyContext) => {
  const { baseUrl, state, complete, rpc } = context;
  const reject: (assertion: string) => never = context.reject;
  state.step = "tools/list";
  const listed = jsonRpcResult(
    await rpc({
      baseUrl,
      token: requireReviewToken(context),
      era: "modern",
      id: 2,
      method: "tools/list",
      params: {},
    }),
  );
  if (!v.is(toolsListResultSchema, listed)) {
    reject("expected a nonempty tool list");
  }
  const tools = new Set(listed.tools.map(({ name }) => name));
  if (
    REVIEW_FORBIDDEN_TOOLS.some((name) => tools.has(name)) ||
    ["list_tasks", "save_task", "delete_task"].some((name) => !tools.has(name))
  ) {
    reject("expected read/write tools and no admin or billing tools");
  }
  complete();
};

const readReviewSample = async (context: ReviewJourneyContext) => {
  const { state, complete, callTool } = context;
  const reject: (assertion: string) => never = context.reject;
  state.step = "read";
  const read = await callTool("list_tasks", { limit: 100 });
  if (!v.is(reviewTaskListSchema, read)) {
    reject("expected sample task records");
  }
  const sampleNames: ReadonlySet<string> = new Set(
    SAMPLE_MATTERS.flatMap(({ tasks }) => tasks.map(({ name }) => name)),
  );
  const sample = read.tasks.find(({ name }) => sampleNames.has(name));
  if (!sample) {
    reject("expected at least one seeded sample task");
  }
  complete();
  return sample;
};

const writeReviewTask = async (
  context: ReviewJourneyContext,
  sample: v.InferOutput<typeof reviewTaskListSchema>["tasks"][number],
) => {
  const { state, complete, callTool } = context;
  const reject: (assertion: string) => never = context.reject;
  state.step = "write";
  const taskName = `Restricted account canary ${Bun.randomUUIDv7()}`;
  const written = await callTool("save_task", {
    matter_id: sample.matterId,
    name: taskName,
  });
  if (!v.is(v.object({ taskId: reviewTaskIdSchema }), written)) {
    reject("expected the created task ID");
  }
  state.createdTaskId = written.taskId;
  complete();
  return taskName;
};

type ReviewTaskAssertionOptions = {
  context: ReviewJourneyContext;
  sample: v.InferOutput<typeof reviewTaskListSchema>["tasks"][number];
  taskName: string;
};
const assertReviewTask = async ({
  context,
  sample,
  taskName,
}: ReviewTaskAssertionOptions) => {
  const { state, complete, callTool } = context;
  const reject: (assertion: string) => never = context.reject;
  state.step = "assert";
  const taskId = state.createdTaskId;
  if (!taskId) {
    reject("created task ID unavailable");
  }
  const reread = await callTool("list_tasks", {
    matter_id: sample.matterId,
    task_id: state.createdTaskId,
  });
  if (
    !v.is(
      v.object({
        task: v.object({
          taskId: v.literal(taskId),
          name: v.literal(taskName),
        }),
      }),
      reread,
    )
  ) {
    reject("created task did not round-trip in the sample matter");
  }
  complete();
};

type ReviewAuthorization = Awaited<ReturnType<typeof authorizeReviewOAuth>>;

const cleanupReviewTask = async (context: ReviewJourneyContext) => {
  const { state, results } = context;
  if (state.createdTaskId && state.token) {
    state.step = "cleanup";
    const cleanup = await Result.tryPromise({
      try: async () => {
        const deleted = await context.callTool("delete_task", {
          task_id: state.createdTaskId,
          confirm: true,
        });
        if (!v.is(v.object({ deleted: v.literal(true) }), deleted)) {
          context.reject("expected the per-run task to be deleted");
        }
        context.complete();
      },
      catch: (error) => error,
    });
    if (cleanup.isErr()) {
      results.push(
        failed(
          reviewJourneyName(state.step),
          cleanup.error instanceof ReviewJourneyError
            ? cleanup.error.message
            : `HTTP unavailable; envelope code none; ${describeProbeFailure(cleanup.error)}`,
        ),
      );
    }
  }
};

export const runReviewAccountJourney = async (
  {
    baseUrl,
    configuredBaseUrl,
    frontendUrl = baseUrl,
    password,
    email = "review@stll.app",
    mode,
  }: ReviewAccountJourneyOptions,
  fetcher: CanaryFetcher = deploymentFetcher,
): Promise<ProbeResult[]> => {
  if (mode !== "full") {
    return [];
  }
  if (!password || baseUrl !== configuredBaseUrl) {
    return [
      skipped(
        reviewJourneyName("sign-in"),
        !password
          ? "no REVIEW_ACCOUNT_PASSWORD configured"
          : "credential withheld: target is not the configured endpoint",
      ),
    ];
  }

  const context = createReviewJourneyContext(
    { baseUrl, configuredBaseUrl, frontendUrl },
    fetcher,
  );
  const { results, state } = context;
  const outcome = await Result.tryPromise({
    try: async () => {
      await signInReviewAccount({ context, email, password });
      await checkReviewSession(context, email);
      const metadata = await discoverReviewOAuth(context);
      const authorization = await authorizeReviewOAuth(context, metadata);
      const redirect = await consentReviewOAuth(
        context,
        authorization.redirect,
      );
      const code = await captureReviewCallback({
        context,
        redirect,
        stateValue: authorization.stateValue,
        callback: authorization.callback,
      });
      await exchangeReviewToken({ context, authorization, code });
      context.complete();
      await initializeReviewMcp(context);
      await listReviewTools(context);
      const sample = await readReviewSample(context);
      const taskName = await writeReviewTask(context, sample);
      await assertReviewTask({ context, sample, taskName });
    },
    catch: (error) => error,
  });
  if (outcome.isErr()) {
    const error = outcome.error;
    results.push(
      failed(
        reviewJourneyName(state.step),
        error instanceof ReviewJourneyError
          ? error.message
          : `HTTP unavailable; envelope code none; ${describeProbeFailure(error)}`,
      ),
    );
  }
  await state.callback?.close();
  await cleanupReviewTask(context);
  return results;
};

const REFRESH_JOURNEY_NAME = "OAuth refresh";
const REFRESH_ROUNDS = [1, 2, 3] as const;
const refreshTokenSchema = v.object({
  access_token: v.pipe(v.string(), v.nonEmpty()),
  refresh_token: v.pipe(v.string(), v.nonEmpty()),
});
const revocationMetadataSchema = v.object({
  revocation_endpoint: v.pipe(v.string(), v.url()),
});

type RefreshJourneyOptions = {
  baseUrl: string;
  frontendUrl?: string | undefined;
  environment: "staging" | "production";
  smokeSecret?: string | undefined;
};

export const runRefreshJourney = async (
  {
    baseUrl,
    frontendUrl = baseUrl,
    environment,
    smokeSecret,
  }: RefreshJourneyOptions,
  fetcher: CanaryFetcher = deploymentFetcher,
): Promise<ProbeResult[]> => {
  if (environment === "production") {
    return [
      {
        ...skipped(
          REFRESH_JOURNEY_NAME,
          "no prod browser session mechanism for the canary org",
        ),
        reason: "no_prod_browser_session",
      },
    ];
  }
  if (!smokeSecret) {
    return [
      failed(
        `${REFRESH_JOURNEY_NAME}: bootstrap`,
        "missing SMOKE_SESSION_SECRET",
      ),
    ];
  }
  const context = createReviewJourneyContext(
    {
      baseUrl,
      configuredBaseUrl: baseUrl,
      frontendUrl,
      journey: REFRESH_JOURNEY_NAME,
      scope: `${CANARY_SCOPE} offline_access`,
    },
    fetcher,
  );
  const { state, results, request, complete, cookies } = context;
  const reject: (assertion: string) => never = context.reject;
  let authorization: ReviewAuthorization | undefined;
  let revocationEndpoint: string | undefined;
  const outcome = await Result.tryPromise({
    try: async () => {
      state.step = "bootstrap";
      const smoke = await request(new URL("/smoke/session", baseUrl), {
        method: "POST",
        headers: { "x-smoke-secret": smokeSecret },
      });
      const sessionSchema = v.object({
        cookieName: v.pipe(v.string(), v.nonEmpty()),
        cookieValue: v.pipe(v.string(), v.nonEmpty()),
      });
      if (!v.is(sessionSchema, smoke)) {
        reject("expected a staging browser session");
      }
      // The smoke session is issued for the configured app and API origins.
      // Never attach it to an origin supplied by discovery or a redirect.
      for (const origin of new Set([
        new URL(baseUrl).origin,
        new URL(frontendUrl).origin,
      ])) {
        cookies.set(origin, new Map([[smoke.cookieName, smoke.cookieValue]]));
      }
      complete();
      const metadata = await discoverReviewOAuth(context);
      if (!v.is(revocationMetadataSchema, metadata)) {
        reject("expected a revocation endpoint");
      }
      revocationEndpoint = metadata.revocation_endpoint;
      authorization = await authorizeReviewOAuth(context, metadata);
      const redirect = await consentReviewOAuth(
        context,
        authorization.redirect,
      );
      const code = await captureReviewCallback({
        context,
        redirect,
        stateValue: authorization.stateValue,
        callback: authorization.callback,
      });
      const acceptTokens = (body: unknown, previous?: string) => {
        // Retain a returned successor for cleanup even if its access token is malformed.
        if (
          v.is(
            v.object({ refresh_token: v.pipe(v.string(), v.nonEmpty()) }),
            body,
          )
        ) {
          state.refreshToken = body.refresh_token;
        }
        if (
          !v.is(refreshTokenSchema, body) ||
          body.refresh_token === previous
        ) {
          reject("expected an access token and a rotated refresh token");
        }
        state.token = body.access_token;
      };
      acceptTokens(await exchangeReviewToken({ context, authorization, code }));
      complete();
      for (const round of REFRESH_ROUNDS) {
        state.step = `refresh ${String(round)}`;
        const previous = state.refreshToken;
        if (!previous) {
          reject("refresh token unavailable");
        }
        const refreshed = await request(authorization.tokenEndpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: authorization.clientId,
            refresh_token: previous,
            resource: new URL(MCP_HTTP_PATH, baseUrl).toString(),
          }).toString(),
        });
        acceptTokens(refreshed, previous);
        complete();
        await initializeReviewMcp(
          context,
          `successor ${String(round)} initialize`,
        );
        state.step = `successor ${String(round)} read`;
        const body = await context.rpc({
          baseUrl,
          token: requireReviewToken(context),
          era: "modern",
          id: 3,
          method: "tools/call",
          params: {
            name: "search_case_law",
            arguments: { queries: ["contract"], country: "CZ", limit: 1 },
          },
        });
        if (
          evaluateToolCall({ status: 200, body }).status !== PROBE_STATUS.passed
        ) {
          reject("expected a read-only tool result with content");
        }
        complete();
      }
    },
    catch: (error) => error,
  });
  if (outcome.isErr()) {
    results.push(
      failed(
        `${REFRESH_JOURNEY_NAME}: ${state.step}`,
        outcome.error instanceof ReviewJourneyError
          ? outcome.error.message
          : describeProbeFailure(outcome.error),
      ),
    );
  }
  const cleanupToken = state.refreshToken;
  if (cleanupToken && authorization && revocationEndpoint) {
    const tokenToRevoke = cleanupToken;
    const clientId = authorization.clientId;
    const endpoint = revocationEndpoint;
    const cleanup = await runNamedProbe(
      `${REFRESH_JOURNEY_NAME}: revoke`,
      async () => {
        await request(endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            token: tokenToRevoke,
            token_type_hint: "refresh_token",
          }).toString(),
        });
        return passed(
          `${REFRESH_JOURNEY_NAME}: revoke`,
          "per-run grant revoked",
        );
      },
    );
    results.push(
      cleanup.status === PROBE_STATUS.failed
        ? { ...cleanup, status: PROBE_STATUS.warned }
        : cleanup,
    );
  } else {
    results.push(
      notApplicable(
        `${REFRESH_JOURNEY_NAME}: revoke`,
        "no refresh token returned",
      ),
    );
  }
  await state.callback?.close();
  return results;
};

const run = async () => {
  const baseUrl = process.env["MCP_CANARY_BASE_URL"];
  if (!baseUrl) {
    console.error("[mcp-canary] MCP_CANARY_BASE_URL is not set.");
    process.exitCode = 1;
    return;
  }

  const token =
    process.env[MCP_CANARY_JOURNEY_CREDENTIALS.productionBearer.env.token];
  const mode = process.env["MCP_CANARY_MODE"] ?? "frequent";
  if (mode !== "frequent" && mode !== "full") {
    console.error("[mcp-canary] MCP_CANARY_MODE must be frequent or full.");
    process.exitCode = 1;
    return;
  }
  const environment = process.env["MCP_CANARY_ENVIRONMENT"] ?? "production";
  if (environment !== "production" && environment !== "staging") {
    console.error(
      "[mcp-canary] MCP_CANARY_ENVIRONMENT must be production or staging.",
    );
    process.exitCode = 1;
    return;
  }
  const results = [
    ...(await runOAuthJourneys({
      baseUrl,
      mode,
      frontendUrl: process.env["MCP_CANARY_FRONTEND_URL"],
    })),
    ...(await runPublicProbes(baseUrl)),
  ];
  results.push(
    ...(await runRefreshJourney({
      baseUrl,
      frontendUrl: process.env["MCP_CANARY_FRONTEND_URL"],
      environment,
      smokeSecret:
        process.env[
          MCP_CANARY_JOURNEY_CREDENTIALS.stagingSession.env.smokeSecret
        ],
    })),
  );
  results.push(
    ...(await runReviewAccountJourney({
      baseUrl,
      configuredBaseUrl:
        process.env[
          MCP_CANARY_JOURNEY_CREDENTIALS.reviewAccount.env.configuredBaseUrl
        ] ?? "https://api.stll.app",
      frontendUrl: process.env["MCP_CANARY_FRONTEND_URL"],
      email:
        process.env[MCP_CANARY_JOURNEY_CREDENTIALS.reviewAccount.env.email],
      password:
        process.env[MCP_CANARY_JOURNEY_CREDENTIALS.reviewAccount.env.password],
      mode,
    })),
  );
  if (environment === "staging") {
    results.push(
      ...(await runStagingCredentialJourneys({
        baseUrl,
        smokeSecret:
          process.env[
            MCP_CANARY_JOURNEY_CREDENTIALS.stagingSession.env.smokeSecret
          ],
      })),
    );
  } else {
    results.push(
      notApplicable(
        "desktop handoff redeem",
        "browser-authorized desktop handoffs are exercised by the staging smoke; production needs no browser credential",
      ),
    );
    if (token) {
      results.push(...(await runAuthenticatedProbes({ baseUrl, token })));
      results.push(
        await runNamedProbe(
          "canary bearer expiry",
          async () => await runCredentialExpiryProbe({ baseUrl, token }),
        ),
      );
    } else {
      results.push(
        ...AUTHENTICATED_PROBES.map(({ name }) =>
          skipped(name, "no MCP_CANARY_TOKEN configured"),
        ),
      );
      results.push(
        skipped("canary bearer expiry", "no MCP_CANARY_TOKEN configured"),
      );
    }
  }

  for (const result of results) {
    if (
      result.status === PROBE_STATUS.skipped ||
      result.status === PROBE_STATUS.warned
    ) {
      console.warn(
        `::warning title=MCP canary coverage incomplete::${result.name}: ${result.detail}`,
      );
    }
    console.log(
      `[mcp-canary] ${PROBE_ICONS[result.status]} ${result.name}: ${result.detail}`,
    );
  }

  const { failed: failures, skipped: skips } = summarize(results);
  if (skips > 0) {
    console.log(
      `[mcp-canary] ${String(skips)} probe(s) skipped: journey coverage is incomplete; configure the named credentials.`,
    );
  }
  if (
    failures > 0 ||
    (skips > 0 && process.env["MCP_CANARY_REQUIRE_CREDENTIALS"] === "true")
  ) {
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await run().catch((error: unknown) => {
    // Never print the raw error: a fetch failure can echo the request URL and
    // headers, and the token rides in one of them.
    const message =
      error instanceof Error ? error.constructor.name : "unknown error";
    console.error(`[mcp-canary] probe run failed (${message}).`);
    process.exitCode = 1;
  });
}
