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
import { TaggedError } from "better-result";
import { createHash, randomBytes } from "node:crypto";
import * as v from "valibot";

import { MCP_DEFAULT_RESOURCE_SCOPES } from "@stll/api-contract";
import { fetchWithTimeout } from "@stll/fetch";
import { DAY_IN_MS, Temporal } from "@stll/time";

import {
  MCP_DISCOVERY_PATH,
  MCP_HTTP_PATH,
  MCP_NOTIFICATION_KEEP_ALIVE_MS,
} from "@/api/mcp/constants";

const PROBE_TIMEOUT_MS = MCP_NOTIFICATION_KEEP_ALIVE_MS * 4;
const STREAM_OPEN_OBSERVATION_MS = 100;
const SSE_CONTENT_TYPE = "text/event-stream";
const CANARY_CLIENT_NAME = "stella-mcp-canary";
const MODERN_PROTOCOL_VERSION = "2026-07-28";

const PROBE_STATUS = {
  failed: "failed",
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
      "expected a non-error JSON-RPC tool result with content",
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
  if (status !== 200 || !v.is(schema, body)) {
    return failed(name, "could not inspect the current machine key expiry");
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
                },
                body: JSON.stringify({
                  correlationId,
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
          await fetcher(new URL("/v1/smoke/session", baseUrl), {
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

const run = async () => {
  const baseUrl = process.env["MCP_CANARY_BASE_URL"];
  if (!baseUrl) {
    console.error("[mcp-canary] MCP_CANARY_BASE_URL is not set.");
    process.exitCode = 1;
    return;
  }

  const token = process.env["MCP_CANARY_TOKEN"];
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
  if (environment === "staging") {
    results.push(
      ...(await runStagingCredentialJourneys({
        baseUrl,
        smokeSecret: process.env["SMOKE_SESSION_SECRET"],
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
    if (result.status === PROBE_STATUS.skipped) {
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
