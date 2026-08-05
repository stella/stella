/**
 * Canary for the MCP transport of a *deployed* API.
 *
 * The transport can fail while every response still carries a 2xx: an
 * endpoint that answers `GET` with a stream body the stateless per-request
 * teardown truncates, an `initialize` that returns a JSON-RPC error inside a
 * 200, or a tool list that comes back empty. None of those raise a 5xx, log an
 * error, or trip an alarm, so the only observer is the client whose session
 * silently stops working. This canary drives the handshake a real client
 * drives and treats a well-formed session as the pass condition.
 *
 * Read-only by construction: it never calls a tool, so it cannot touch tenant
 * data. Response bodies are parsed but never printed, only the shape assertions
 * that failed.
 *
 * Without `MCP_CANARY_TOKEN` the authenticated probes cannot run. They are then
 * reported as skipped and the run stays green on the public surface alone;
 * skips are always named so a credential-less run never reads as full coverage.
 */

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import * as v from "valibot";

import { fetchWithTimeout } from "@/api/lib/fetch";
import {
  MCP_DISCOVERY_PATH,
  MCP_HTTP_PATH,
  MCP_SSE_UNSUPPORTED_ALLOW_HEADER,
} from "@/api/mcp/constants";

const PROBE_TIMEOUT_MS = 20_000;
const SSE_CONTENT_TYPE = "text/event-stream";
const CANARY_CLIENT_NAME = "stella-mcp-canary";

/** Order and spacing are the server's business; the method set is not. */
const parseAllowedMethods = (allow: string | null): string[] =>
  (allow ?? "")
    .split(",")
    .map((method) => method.trim().toUpperCase())
    .filter((method) => method.length > 0)
    .toSorted();

const EXPECTED_ALLOWED_METHODS = parseAllowedMethods(
  MCP_SSE_UNSUPPORTED_ALLOW_HEADER,
);

const PROBE_STATUS = {
  failed: "failed",
  passed: "passed",
  skipped: "skipped",
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
  initialize: `POST ${MCP_HTTP_PATH} (initialize)`,
  stream: `GET ${MCP_HTTP_PATH} (notification stream)`,
  toolsList: `POST ${MCP_HTTP_PATH} (tools/list)`,
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
 * The transport is stateless, so it cannot hold a server-initiated stream open
 * and must say so with 405. Answering `GET` with `text/event-stream` hands the
 * client a body that per-request teardown has already ended; the client sees
 * the stream die on open and reconnects forever instead of calling tools.
 */
export const evaluateStreamRefusal = ({
  allow,
  contentType,
  status,
}: Pick<ProbeResponse, "allow" | "contentType" | "status">): ProbeResult => {
  const name = PROBE_NAMES.stream;
  if (mediaType(contentType) === SSE_CONTENT_TYPE) {
    return failed(name, `${String(status)} ${SSE_CONTENT_TYPE} (expected 405)`);
  }
  if (status !== 405) {
    return failed(name, `${String(status)} (expected 405)`);
  }
  // The refusal is only actionable if it also tells the client what the
  // endpoint does serve; a 405 with a wrong or missing Allow is a dead end.
  const allowed = parseAllowedMethods(allow);
  if (allowed.join(",") !== EXPECTED_ALLOWED_METHODS.join(",")) {
    return failed(
      name,
      `405 allowing ${allowed.join(", ") || "nothing"} (expected ${MCP_SSE_UNSUPPORTED_ALLOW_HEADER})`,
    );
  }
  return passed(name, "405, so clients stay on request/response");
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
  id: number;
  method: string;
  params: Record<string, unknown>;
  token: string;
};

const postJsonRpc = async ({
  baseUrl,
  id,
  method,
  params,
  token,
}: JsonRpcCall): Promise<ProbeResponse> =>
  await readProbeResponse(
    await fetchWithTimeout(new URL(MCP_HTTP_PATH, baseUrl), {
      body: JSON.stringify({ id, jsonrpc: "2.0", method, params }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
      },
      method: "POST",
      timeoutMs: PROBE_TIMEOUT_MS,
    }),
  );

const runPublicProbes = async (baseUrl: string): Promise<ProbeResult[]> => {
  const discovery = await readProbeResponse(
    await fetchWithTimeout(new URL(MCP_DISCOVERY_PATH, baseUrl), {
      headers: { accept: "application/json" },
      method: "GET",
      timeoutMs: PROBE_TIMEOUT_MS,
    }),
  );
  const unauthenticated = await readProbeResponse(
    await fetchWithTimeout(new URL(MCP_HTTP_PATH, baseUrl), {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      method: "POST",
      timeoutMs: PROBE_TIMEOUT_MS,
    }),
  );

  return [
    evaluateDiscovery(discovery),
    evaluateUnauthenticated(unauthenticated),
  ];
};

type CanaryTarget = { baseUrl: string; token: string };

type AuthenticatedProbe = {
  name: string;
  run: (target: CanaryTarget) => Promise<ProbeResult>;
};

/**
 * The single declaration of what a credentialed run does. Execution and the
 * skip report both read it, so neither can describe a probe the other lacks.
 */
export const AUTHENTICATED_PROBES = [
  {
    name: PROBE_NAMES.stream,
    run: async ({ baseUrl, token }) =>
      evaluateStreamRefusal(
        await readProbeResponse(
          await fetchWithTimeout(new URL(MCP_HTTP_PATH, baseUrl), {
            headers: {
              accept: SSE_CONTENT_TYPE,
              authorization: `Bearer ${token}`,
            },
            method: "GET",
            timeoutMs: PROBE_TIMEOUT_MS,
          }),
        ),
      ),
  },
  {
    name: PROBE_NAMES.initialize,
    run: async ({ baseUrl, token }) =>
      evaluateInitialize(
        await postJsonRpc({
          baseUrl,
          id: 1,
          method: "initialize",
          params: {
            capabilities: {},
            clientInfo: { name: CANARY_CLIENT_NAME, version: "1.0.0" },
            protocolVersion: LATEST_PROTOCOL_VERSION,
          },
          token,
        }),
      ),
  },
  {
    name: PROBE_NAMES.toolsList,
    run: async ({ baseUrl, token }) =>
      evaluateToolsList(
        await postJsonRpc({
          baseUrl,
          id: 2,
          method: "tools/list",
          params: {},
          token,
        }),
      ),
  },
] as const satisfies readonly AuthenticatedProbe[];

// Concurrent because the endpoint is stateless: no probe depends on another
// having run, so ordering them would only lengthen the run.
const runAuthenticatedProbes = async (
  target: CanaryTarget,
): Promise<ProbeResult[]> =>
  await Promise.all(
    AUTHENTICATED_PROBES.map(async ({ run }) => await run(target)),
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
} as const satisfies Record<ProbeStatus, string>;

const run = async () => {
  const baseUrl = process.env["MCP_CANARY_BASE_URL"];
  if (!baseUrl) {
    console.error("[mcp-canary] MCP_CANARY_BASE_URL is not set.");
    process.exitCode = 1;
    return;
  }

  const token = process.env["MCP_CANARY_TOKEN"];
  const results = [
    ...(await runPublicProbes(baseUrl)),
    ...(token
      ? await runAuthenticatedProbes({ baseUrl, token })
      : AUTHENTICATED_PROBES.map(({ name }) =>
          skipped(name, "no MCP_CANARY_TOKEN configured"),
        )),
  ];

  for (const result of results) {
    console.log(
      `[mcp-canary] ${PROBE_ICONS[result.status]} ${result.name}: ${result.detail}`,
    );
  }

  const { failed: failures, skipped: skips } = summarize(results);
  if (skips > 0) {
    console.log(
      `[mcp-canary] ${String(skips)} probe(s) skipped: the authenticated session was not exercised.`,
    );
  }
  if (failures > 0) {
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
