import { panic, Result } from "better-result";
import { timingSafeEqual } from "node:crypto";
import * as v from "valibot";

import { isChatLocalRunBrowserAction } from "@stll/api-contract/chat-local-run-tool";
import type { DesktopRunnerApprovalMode } from "@stll/api-contract/desktop-runner";

import { LOCAL_BROWSER_MCP_SERVER_NAME } from "../../harness/tool-parts";
import type { StellaSandboxMcpBinding } from "../../sandbox";
import type { BrowserBridge, BrowserBridgeDownload } from "./bridge";
import {
  type BrowserDownloadOutcome,
  receiveBrowserDownload,
} from "./downloads";
import {
  type ApproveAction,
  createLocalBrowserSession,
  localBrowserToolList,
} from "./tools";

/**
 * The browser tools' MCP endpoint for local harnesses: served here, on the
 * computer, not forwarded anywhere. Like the stella MCP proxy it listens on
 * 127.0.0.1 only, at a random port, and each run gets its own path and
 * secret; a request without them, for another `Host`, or from a browser page
 * (an `Origin` header) is refused. It speaks MCP's streamable HTTP transport
 * with JSON answers and no sessions or event streams.
 */

const ROUTE_PREFIX = "/browser/";
const SECRET_BYTES = 32;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const JSON_RPC_ERROR = {
  parse: -32_700,
  invalidRequest: -32_600,
  methodNotFound: -32_601,
  invalidParams: -32_602,
} as const;

const rpcRequestSchema = v.object({
  id: v.optional(v.union([v.string(), v.number()])),
  jsonrpc: v.literal("2.0"),
  method: v.optional(v.string()),
  params: v.optional(v.unknown()),
});

const initializeParamsSchema = v.object({
  protocolVersion: v.optional(v.string()),
});

const toolCallParamsSchema = v.object({
  arguments: v.optional(v.unknown()),
  name: v.string(),
});

const CANCELLED_NOTIFICATION = "notifications/cancelled";

const cancelledParamsSchema = v.object({
  requestId: v.union([v.string(), v.number()]),
});

/** The run an endpoint serves. */
type BrowserMcpRun = {
  runId: string;
  threadId: string;
  /** The run's approval mode: which browser steps wait for the member. */
  approvals: DesktopRunnerApprovalMode;
  /** Asks the run's member to allow one browser step. */
  approve: ApproveAction;
  /** Cut when the run is stopped: its browser steps end at once. */
  stopped: AbortSignal;
  /** The run's folder: a PDF its chat's tab downloads is saved there. */
  workspaceDir: string;
};

/** A run calling through an endpoint. */
type Serving = {
  run: BrowserMcpRun;
  /** Cut once the run calls through the endpoint no more. */
  ended: AbortController;
  /** Each `tools/call` in flight, by its request id, for the harness to cancel. */
  calls: Map<string | number, AbortController>;
};

type Endpoint = {
  /** Fixed length: a presented value of another length is refused early. */
  secret: Buffer;
  /** `null` while parked: no run calls through it. */
  serving: Serving | null;
};

const serve = (run: BrowserMcpRun): Serving => ({
  run,
  ended: new AbortController(),
  calls: new Map(),
});

export type LocalBrowserMcp = {
  /** `http://127.0.0.1:<port>`, for logs and tests. */
  readonly origin: string;
  /** The binding a run's harness configuration receives. */
  register: (run: BrowserMcpRun) => StellaSandboxMcpBinding;
  /**
   * Ends the run's access and stops its command in the extension; its
   * endpoint goes, unless `park` kept it.
   */
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
   * endpoint serves this run, with its address and secret kept. `null`
   * when the endpoint is not parked.
   */
  adopt: (
    endpoint: string,
    run: BrowserMcpRun,
  ) => StellaSandboxMcpBinding | null;
  /** The parked endpoint's process is gone: the endpoint goes too. */
  drop: (endpoint: string) => void;
  stop: () => Promise<void>;
};

const BEARER = /^Bearer (\S+)$/u;

const presentsSecret = (request: Request, held: Endpoint) => {
  const bearer = BEARER.exec(request.headers.get("authorization") ?? "")?.[1];
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

const rpcResult = (id: string | number, result: unknown) =>
  Response.json({ id, jsonrpc: "2.0", result });

const rpcError = (id: string | number | null, code: number, message: string) =>
  Response.json({ error: { code, message }, id, jsonrpc: "2.0" });

type Body = { type: "json"; value: unknown } | { type: "unreadable" };

const readBody = async (request: Request): Promise<Body> => {
  const text = await Result.tryPromise(async () => await request.text());
  const parsed = Result.isOk(text)
    ? Result.try((): unknown => JSON.parse(text.value))
    : text;
  return Result.isOk(parsed)
    ? { type: "json", value: parsed.value }
    : { type: "unreadable" };
};

/** The harness gave up on a call without closing its request. */
const cancelCall = ({ calls }: Serving, params: unknown) => {
  const cancelled = v.safeParse(cancelledParamsSchema, params);
  if (cancelled.success) {
    calls.get(cancelled.output.requestId)?.abort();
  }
};

type CallInFlight = {
  serving: Serving;
  id: string | number;
  /** Aborts when the harness closes the call's request. */
  requestSignal: AbortSignal;
};

/**
 * Runs one `tools/call` under a signal that ends with its request, its
 * cancellation, the run's stop or the run's end, whichever comes first: a
 * question it asked is withdrawn and nothing more is sent to Chrome for it.
 */
const whileCalling = async <T>(
  { id, requestSignal, serving: { calls, ended, run } }: CallInFlight,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const cancel = new AbortController();
  calls.set(id, cancel);
  return await call(
    AbortSignal.any([requestSignal, cancel.signal, run.stopped, ended.signal]),
  ).finally(() => {
    if (calls.get(id) === cancel) {
      calls.delete(id);
    }
  });
};

/**
 * The endpoints by key (the id of the run that registered each) and the key
 * each run calls through: its own, or the one it adopted.
 */
const createEndpoints = () => {
  const endpoints = new Map<string, Endpoint>();
  const runs = new Map<string, string>();
  return {
    get: (key: string) => endpoints.get(key),
    add: (run: BrowserMcpRun, secret: Buffer) => {
      endpoints.set(run.runId, { serving: serve(run), secret });
      runs.set(run.runId, run.runId);
    },
    /**
     * The run calls through its endpoint no more, which then serves no run:
     * the endpoint's key and the run, or `null` when it held none. Every
     * call the run still has open ends with it.
     */
    detach: (runId: string) => {
      const key = runs.get(runId);
      runs.delete(runId);
      const endpoint = key === undefined ? undefined : endpoints.get(key);
      const serving = endpoint?.serving ?? null;
      if (key === undefined || endpoint === undefined || serving === null) {
        return null;
      }
      endpoint.serving = null;
      serving.ended.abort();
      return { held: serving.run, key };
    },
    /** A parked endpoint serves `run`; `null` when it is not parked. */
    attach: (key: string, run: BrowserMcpRun) => {
      const endpoint = endpoints.get(key);
      if (
        endpoint === undefined ||
        endpoint.serving !== null ||
        runs.has(run.runId)
      ) {
        return null;
      }
      endpoint.serving = serve(run);
      runs.set(run.runId, key);
      return endpoint;
    },
    remove: (key: string) => {
      endpoints.delete(key);
    },
    /** Whether a run of `threadId` still calls through any endpoint. */
    servesThread: (threadId: string) =>
      [...endpoints.values()].some(
        (other) => other.serving?.run.threadId === threadId,
      ),
    /** A run of `threadId` calling through an endpoint now, if any. */
    runOf: (threadId: string): BrowserMcpRun | null =>
      [...endpoints.values()]
        .map((other) => other.serving?.run ?? null)
        .find((run) => run?.threadId === threadId) ?? null,
    clear: () => {
      for (const { serving } of endpoints.values()) {
        serving?.ended.abort();
      }
      endpoints.clear();
      runs.clear();
    },
  };
};

type LocalBrowserSession = ReturnType<typeof createLocalBrowserSession>;

/** Downloads one chat keeps for its next browser result; older ones go first. */
const MAX_HELD_DOWNLOADS = 16;

type HeldDownload =
  | { type: "saving"; outcome: Promise<BrowserDownloadOutcome> }
  | { type: "waiting"; download: BrowserBridgeDownload["download"] };

/**
 * Each chat's downloads until a browser result of the chat reports them.
 * One that arrives while a run of the chat is held is saved into that run's
 * folder at once; one that arrives between runs waits for the next run's
 * folder.
 */
const createDownloadInbox = (
  runOf: (threadId: string) => BrowserMcpRun | null,
  /** The member's home folder: Chrome saves downloads under it. */
  home: string,
) => {
  const chats = new Map<string, HeldDownload[]>();
  const receive = async (
    download: BrowserBridgeDownload["download"],
    run: BrowserMcpRun,
  ) =>
    await receiveBrowserDownload(download, {
      home,
      workspaceDir: run.workspaceDir,
    });
  return {
    arrive: ({ controllerId, download }: BrowserBridgeDownload) => {
      const run = runOf(controllerId);
      const held: HeldDownload =
        run === null
          ? { download, type: "waiting" }
          : { outcome: receive(download, run), type: "saving" };
      chats.set(
        controllerId,
        [...(chats.get(controllerId) ?? []), held].slice(-MAX_HELD_DOWNLOADS),
      );
    },
    /** The chat's downloads so far, saved into `run`'s folder; reported once. */
    take: async (run: BrowserMcpRun): Promise<BrowserDownloadOutcome[]> => {
      const held = chats.get(run.threadId) ?? [];
      chats.delete(run.threadId);
      return await Promise.all(
        held.map(async (entry) => {
          switch (entry.type) {
            case "saving":
              return await entry.outcome;
            case "waiting":
              return await receive(entry.download, run);
            default:
              entry satisfies never;
              return panic("Unhandled held download");
          }
        }),
      );
    },
    clear: () => {
      chats.clear();
    },
  };
};

/** A chat's page state, kept while any run of the chat is held. */
const sessionFor = (
  sessions: Map<string, LocalBrowserSession>,
  threadId: string,
) => {
  const existing = sessions.get(threadId);
  if (existing !== undefined) {
    return existing;
  }
  const created = createLocalBrowserSession();
  sessions.set(threadId, created);
  return created;
};

export const startLocalBrowserMcp = ({
  bridge,
  home,
  version,
}: {
  bridge: BrowserBridge;
  /** The member's home folder: Chrome's downloads are taken only from under it. */
  home: string;
  /** The sidecar's version, reported as the server's. */
  version: string;
}): LocalBrowserMcp => {
  const endpoints = createEndpoints();
  const sessions = new Map<string, LocalBrowserSession>();
  const downloads = createDownloadInbox(endpoints.runOf, home);
  bridge.onDownload(downloads.arrive);
  const listener = { host: "" };

  const answer = async (
    serving: Serving,
    message: v.InferOutput<typeof rpcRequestSchema>,
    requestSignal: AbortSignal,
  ): Promise<Response> => {
    const { id, method } = message;
    const held = serving.run;
    if (id === undefined) {
      if (method === CANCELLED_NOTIFICATION) {
        cancelCall(serving, message.params);
      }
      // A notification, or an answer to a request this server never sends.
      return new Response(null, { status: 202 });
    }
    if (method === undefined) {
      return rpcError(
        id,
        JSON_RPC_ERROR.invalidRequest,
        "A request names its method.",
      );
    }
    switch (method) {
      case "initialize": {
        const params = v.safeParse(initializeParamsSchema, message.params);
        const requested = params.success
          ? params.output.protocolVersion
          : undefined;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.find(
          (supported) => supported === requested,
        );
        return rpcResult(id, {
          capabilities: { tools: { listChanged: false } },
          protocolVersion: protocolVersion ?? LATEST_PROTOCOL_VERSION,
          serverInfo: { name: LOCAL_BROWSER_MCP_SERVER_NAME, version },
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: localBrowserToolList() });
      case "tools/call": {
        const params = v.safeParse(toolCallParamsSchema, message.params);
        if (
          !params.success ||
          !isChatLocalRunBrowserAction(params.output.name)
        ) {
          return rpcError(
            id,
            JSON_RPC_ERROR.invalidParams,
            "Unknown tool: call open, snapshot, find, click or type.",
          );
        }
        const { arguments: input, name } = params.output;
        const result = await whileCalling(
          { id, requestSignal, serving },
          async (signal) =>
            await sessionFor(sessions, held.threadId).call(name, input, {
              approvals: held.approvals,
              approve: held.approve,
              downloads: async () => await downloads.take(held),
              signal,
              send: async (command, observedTab) =>
                await bridge.request(
                  {
                    command,
                    controllerId: held.threadId,
                    observedTab,
                    toolCallId: crypto.randomUUID(),
                    turnId: held.runId,
                  },
                  signal,
                ),
            }),
        );
        return rpcResult(id, result);
      }
      default:
        return rpcError(
          id,
          JSON_RPC_ERROR.methodNotFound,
          `Method not found: ${method}.`,
        );
    }
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    // A command waits for the page; the bridge bounds it.
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
        ? decodeURIComponent(pathname.slice(ROUTE_PREFIX.length))
        : null;
      const endpoint = key === null ? undefined : endpoints.get(key);
      // A parked endpoint serves no run.
      const serving = endpoint?.serving ?? null;
      if (endpoint === undefined || serving === null) {
        return refusal(404);
      }
      if (!presentsSecret(request, endpoint)) {
        return refusal(401);
      }
      if (request.method !== "POST") {
        return new Response(null, { headers: { allow: "POST" }, status: 405 });
      }
      const body = await readBody(request);
      // The run may have ended, and another adopted the endpoint, while the
      // body arrived.
      if (endpoint.serving !== serving) {
        return refusal(404);
      }
      if (body.type === "unreadable") {
        return rpcError(null, JSON_RPC_ERROR.parse, "The body is not JSON.");
      }
      const message = v.safeParse(rpcRequestSchema, body.value);
      if (!message.success) {
        return rpcError(
          null,
          JSON_RPC_ERROR.invalidRequest,
          "Expected one JSON-RPC 2.0 message.",
        );
      }
      return await answer(serving, message.output, request.signal);
    },
  });
  const port =
    server.port ?? panic("The browser MCP listener has no TCP port.");
  listener.host = `127.0.0.1:${port}`;
  const origin = `http://${listener.host}`;

  const binding = (key: string, secret: string): StellaSandboxMcpBinding => ({
    serverName: LOCAL_BROWSER_MCP_SERVER_NAME,
    url: `${origin}${ROUTE_PREFIX}${encodeURIComponent(key)}`,
    token: secret,
  });

  /**
   * The run's access ends: its command in the extension stops, its chat's
   * page state goes with the chat's last run, and its endpoint serves no
   * run. The endpoint's key, or `null` when the run held none.
   */
  const endEndpointRun = (runId: string): string | null => {
    const ended = endpoints.detach(runId);
    if (ended === null) {
      return null;
    }
    bridge.cancel({ controllerId: ended.held.threadId, turnId: runId });
    if (!endpoints.servesThread(ended.held.threadId)) {
      sessions.delete(ended.held.threadId);
    }
    return ended.key;
  };

  return {
    origin,
    register: (run) => {
      const secret = Buffer.from(
        crypto.getRandomValues(new Uint8Array(SECRET_BYTES)),
      ).toString("base64url");
      endpoints.add(run, Buffer.from(secret));
      return binding(run.runId, secret);
    },
    unregister: (runId) => {
      const key = endEndpointRun(runId);
      if (key !== null) {
        endpoints.remove(key);
      }
    },
    park: (runId) => endEndpointRun(runId),
    adopt: (key, run) => {
      const endpoint = endpoints.attach(key, run);
      return endpoint === null
        ? null
        : binding(key, endpoint.secret.toString());
    },
    drop: (key) => {
      // Only a parked endpoint: one a run adopted goes with that run.
      if (endpoints.get(key)?.serving === null) {
        endpoints.remove(key);
      }
    },
    stop: async () => {
      endpoints.clear();
      sessions.clear();
      downloads.clear();
      await server.stop(true);
    },
  };
};
