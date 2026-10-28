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
 * secret is worthless once the run ends.
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
/** A run's transcript travels over stdio; MCP bodies stay far below this. */
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

export class McpProxyRegistrationError extends TaggedError(
  "McpProxyRegistrationError",
)<{
  reason: "foreign_upstream" | "duplicate_run";
  message: string;
}> {}

export type McpProxyRun = {
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
  unregister: (runId: string) => void;
  stop: () => Promise<void>;
};

type HeldRun = {
  upstream: URL;
  /** Fixed length: a presented value of another length is refused early. */
  secret: Buffer;
  token: string;
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
  if (match?.[1] === undefined) {
    return false;
  }
  const presented = Buffer.from(match[1]);
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
  const runs = new Map<string, HeldRun>();
  /** `127.0.0.1:<port>`, the only `Host` a request may name. */
  const listener = { host: "" };

  const forward = async (request: Request, held: HeldRun) => {
    const headers = copyHeaders(request.headers, FORWARDED_REQUEST_HEADERS);
    headers.set("authorization", `Bearer ${held.token}`);
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
      const runId = pathname.startsWith(ROUTE_PREFIX)
        ? pathname.slice(ROUTE_PREFIX.length)
        : null;
      const held = runId === null ? undefined : runs.get(runId);
      if (held === undefined) {
        return refusal(404);
      }
      if (!presentsSecret(request, held)) {
        return refusal(401);
      }
      return forward(request, held);
    },
  });
  const port = server.port ?? panic("The MCP proxy listener has no TCP port.");
  listener.host = `127.0.0.1:${port}`;
  const origin = `http://${listener.host}`;

  return {
    origin,
    register: (run) => {
      const upstream = URL.parse(run.upstreamUrl);
      if (upstream === null || !isAllowedUpstream(upstream, apiOrigin)) {
        return Result.err(
          new McpProxyRegistrationError({
            reason: "foreign_upstream",
            message: "The MCP endpoint is not on the stella API origin.",
          }),
        );
      }
      if (runs.has(run.runId)) {
        return Result.err(
          new McpProxyRegistrationError({
            reason: "duplicate_run",
            message: "The run already has an MCP endpoint.",
          }),
        );
      }
      const secret = randomSecret();
      runs.set(run.runId, {
        upstream,
        secret: Buffer.from(secret),
        token: run.token,
        // An unreadable expiry is held as the earliest, so any refresh wins.
        expiresAtMs: instantMs(run.expiresAt) ?? 0,
      });
      return Result.ok({
        serverName: run.serverName,
        url: `${origin}${ROUTE_PREFIX}${encodeURIComponent(run.runId)}`,
        token: secret,
      });
    },
    refresh: (runId, token, expiresAt) => {
      const held = runs.get(runId);
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
    unregister: (runId) => {
      runs.delete(runId);
    },
    stop: async () => {
      runs.clear();
      await server.stop(true);
    },
  };
};
