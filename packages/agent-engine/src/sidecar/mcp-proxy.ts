import { panic, Result, TaggedError } from "better-result";
import { timingSafeEqual } from "node:crypto";
import { Temporal } from "temporal-polyfill/full";

import type { StellaSandboxMcpBinding } from "../sandbox";

/**
 * The MCP endpoint a local harness talks to. It listens on 127.0.0.1 only,
 * at a random port, and forwards each request to the run's stella MCP URL
 * with the run's current token. The harness never holds that token: its MCP
 * configuration names this proxy and a per-run secret, so a refreshed token
 * takes effect on the next request without touching the harness, and the
 * secret is worthless once the run ends. A harness process kept for the
 * chat's next turn keeps its endpoint parked: it forwards nothing until that
 * turn's run adopts it, with the run's own token.
 *
 * What it refuses:
 * - an upstream whose origin is not the configured stella API origin, or
 *   that carries credentials in the URL (at registration, so a run with
 *   such an endpoint never starts);
 * - a request without the run's secret, for a run it does not hold, or whose
 *   `Host` is not this listener (DNS rebinding) or that carries an `Origin`
 *   (a browser page);
 * - an upstream redirect, which would move the token to another URL.
 */

const ROUTE_PREFIX = "/mcp/";
const SECRET_BYTES = 32;
/** Transcripts travel over the holder socket; MCP bodies stay far below. */
const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

/** Headers an MCP client sends that the stella server reads. */
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
] as const;
/** Headers of the stella answer an MCP client reads. */
const FORWARDED_RESPONSE_HEADERS = [
  "cache-control",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
] as const;

class McpProxyRegistrationError extends TaggedError(
  "McpProxyRegistrationError",
)<{
  reason: "foreign_upstream" | "duplicate_run" | "not_parked";
  message: string;
}> {}

type McpProxyRun = {
  runId: string;
  serverName: string;
  /** The stella MCP URL the API handed the run. */
  upstreamUrl: string;
  token: string;
  expiresAt: string;
};

export type McpProxy = {
  /** `http://127.0.0.1:<port>`, for logs and tests. */
  readonly origin: string;
  /** The binding the harness's MCP configuration receives for the run. */
  register: (
    run: McpProxyRun,
  ) => Result<StellaSandboxMcpBinding, McpProxyRegistrationError>;
  /**
   * Replace the run's token from the next request on. A token that expires
   * before the held one is ignored, so a late refresh never rolls back.
   */
  refresh: (runId: string, token: string, expiresAt: string) => boolean;
  /** The run's current token, for the sidecar's own calls; `null` once unheld. */
  tokenOf: (runId: string) => string | null;
  /** The run ended: its endpoint goes, unless `park` kept it. */
  unregister: (runId: string) => void;
  /**
   * The run ended but its harness process stays for the chat's next turn:
   * the endpoint, which that process is configured with, stays and refuses
   * every request until a run adopts it. The endpoint's key, or `null` when
   * the run held none.
   */
  park: (runId: string) => string | null;
  /**
   * A run continuing in the process a parked endpoint belongs to: the
   * endpoint forwards with this run's token, and keeps its address and
   * secret. Refused like `register` for a foreign upstream, and when the
   * endpoint is not parked.
   */
  adopt: (
    endpoint: string,
    run: McpProxyRun,
  ) => Result<StellaSandboxMcpBinding, McpProxyRegistrationError>;
  /** The parked endpoint's process is gone: the endpoint goes too. */
  drop: (endpoint: string) => void;
  stop: () => Promise<void>;
};

type HeldRun = {
  upstream: URL;
  /** Fixed length: a presented value of another length is refused early. */
  secret: Buffer;
  /** `null` while parked: no run forwards through it. */
  token: string | null;
  expiresAtMs: number;
};

/** Epoch milliseconds of an ISO instant; `null` when it is not one. */
const instantMs = (iso: string) => {
  const parsed = Result.try(() => Temporal.Instant.from(iso).epochMilliseconds);
  return Result.isOk(parsed) ? parsed.value : null;
};

const randomSecret = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(SECRET_BYTES))).toString(
    "base64url",
  );

const BEARER = /^Bearer (\S+)$/u;

const presentsSecret = (request: Request, held: HeldRun) => {
  const match = BEARER.exec(request.headers.get("authorization") ?? "");
  if (match === null) {
    return false;
  }
  const [, bearer] = match;
  if (bearer === undefined) {
    return false;
  }
  const presented = Buffer.from(bearer);
  return (
    presented.length === held.secret.length &&
    timingSafeEqual(presented, held.secret)
  );
};

const refusal = (status: number) => new Response(null, { status });

const copyHeaders = (from: Headers, names: readonly string[]) => {
  const headers = new Headers();
  for (const name of names) {
    const value = from.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  return headers;
};

const isAllowedUpstream = (upstream: URL, apiOrigin: string) =>
  upstream.origin === apiOrigin &&
  upstream.username === "" &&
  upstream.password === "";

export const startMcpProxy = ({
  apiOrigin,
}: {
  /** The stella API origin, from the desktop's own configuration. */
  apiOrigin: string;
}): McpProxy => {
  /** Endpoints by key, the id of the run that registered each. */
  const endpoints = new Map<string, HeldRun>();
  /** Each run's endpoint key: its own, or the one it adopted. */
  const runs = new Map<string, string>();
  const endpointOf = (runId: string) => {
    const key = runs.get(runId);
    return key === undefined ? undefined : endpoints.get(key);
  };
  /** `127.0.0.1:<port>`, the only `Host` a request may name. */
  const listener = { host: "" };

  const forward = async (request: Request, held: HeldRun, token: string) => {
    const headers = copyHeaders(request.headers, FORWARDED_REQUEST_HEADERS);
    headers.set("authorization", `Bearer ${token}`);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const upstream = await Result.tryPromise(async () =>
      fetch(held.upstream, {
        method: request.method,
        headers,
        body: hasBody ? request.body : null,
        redirect: "manual",
        signal: request.signal,
      }),
    );
    if (Result.isError(upstream)) {
      return refusal(502);
    }
    const response = upstream.value;
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return refusal(502);
    }
    return new Response(response.body, {
      status: response.status,
      headers: copyHeaders(response.headers, FORWARDED_RESPONSE_HEADERS),
    });
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    // A streamed MCP response may stay quiet for long stretches.
    idleTimeout: 0,
    fetch: async (request) => {
      if (
        request.headers.get("host") !== listener.host ||
        request.headers.has("origin")
      ) {
        return refusal(403);
      }
      const { pathname } = new URL(request.url);
      const key = pathname.startsWith(ROUTE_PREFIX)
        ? pathname.slice(ROUTE_PREFIX.length)
        : null;
      const held = key === null ? undefined : endpoints.get(key);
      // A parked endpoint serves no run: nobody's token is forwarded.
      const token = held?.token ?? null;
      if (held === undefined || token === null) {
        return refusal(404);
      }
      if (!presentsSecret(request, held)) {
        return refusal(401);
      }
      return forward(request, held, token);
    },
  });
  const port = server.port ?? panic("The MCP proxy listener has no TCP port.");
  listener.host = `127.0.0.1:${port}`;
  const origin = `http://${listener.host}`;

  const upstreamOf = (
    run: McpProxyRun,
  ): Result<URL, McpProxyRegistrationError> => {
    const upstream = URL.parse(run.upstreamUrl);
    return upstream === null || !isAllowedUpstream(upstream, apiOrigin)
      ? Result.err(
          new McpProxyRegistrationError({
            reason: "foreign_upstream",
            message: "The MCP endpoint is not on the stella API origin.",
          }),
        )
      : Result.ok(upstream);
  };
  const duplicate = () =>
    Result.err(
      new McpProxyRegistrationError({
        reason: "duplicate_run",
        message: "The run already has an MCP endpoint.",
      }),
    );
  const binding = (
    run: McpProxyRun,
    key: string,
    secret: string,
  ): StellaSandboxMcpBinding => ({
    serverName: run.serverName,
    url: `${origin}${ROUTE_PREFIX}${encodeURIComponent(key)}`,
    token: secret,
  });

  return {
    origin,
    register: (run) => {
      const upstream = upstreamOf(run);
      if (Result.isError(upstream)) {
        return upstream;
      }
      if (runs.has(run.runId) || endpoints.has(run.runId)) {
        return duplicate();
      }
      const secret = randomSecret();
      endpoints.set(run.runId, {
        upstream: upstream.value,
        secret: Buffer.from(secret),
        token: run.token,
        // An unreadable expiry is held as the earliest, so any refresh wins.
        expiresAtMs: instantMs(run.expiresAt) ?? 0,
      });
      runs.set(run.runId, run.runId);
      return Result.ok(binding(run, run.runId, secret));
    },
    refresh: (runId, token, expiresAt) => {
      const held = endpointOf(runId);
      const expiresAtMs = instantMs(expiresAt);
      if (
        held === undefined ||
        expiresAtMs === null ||
        expiresAtMs < held.expiresAtMs
      ) {
        return false;
      }
      held.token = token;
      held.expiresAtMs = expiresAtMs;
      return true;
    },
    tokenOf: (runId) => endpointOf(runId)?.token ?? null,
    unregister: (runId) => {
      const key = runs.get(runId);
      runs.delete(runId);
      if (key !== undefined) {
        endpoints.delete(key);
      }
    },
    park: (runId) => {
      const key = runs.get(runId);
      const held = endpointOf(runId);
      runs.delete(runId);
      if (key === undefined || held === undefined) {
        return null;
      }
      held.token = null;
      held.expiresAtMs = 0;
      return key;
    },
    adopt: (key, run) => {
      const upstream = upstreamOf(run);
      if (Result.isError(upstream)) {
        return upstream;
      }
      if (runs.has(run.runId)) {
        return duplicate();
      }
      const held = endpoints.get(key);
      if (held === undefined || held.token !== null) {
        return Result.err(
          new McpProxyRegistrationError({
            reason: "not_parked",
            message: "The kept harness process has no MCP endpoint to reuse.",
          }),
        );
      }
      held.upstream = upstream.value;
      held.token = run.token;
      held.expiresAtMs = instantMs(run.expiresAt) ?? 0;
      runs.set(run.runId, key);
      return Result.ok(binding(run, key, held.secret.toString()));
    },
    drop: (key) => {
      const held = endpoints.get(key);
      // Only a parked endpoint: one a run adopted goes with that run.
      if (held?.token === null) {
        endpoints.delete(key);
      }
    },
    stop: async () => {
      endpoints.clear();
      runs.clear();
      await server.stop(true);
    },
  };
};
