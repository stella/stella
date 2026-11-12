import { panic, Result } from "better-result";
import { timingSafeEqual } from "node:crypto";
import * as v from "valibot";

import { isChatLocalRunBrowserAction } from "@stll/api-contract/chat-local-run-tool";
import type { DesktopRunnerApprovalMode } from "@stll/api-contract/desktop-runner";

import { LOCAL_BROWSER_MCP_SERVER_NAME } from "../../harness/tool-parts";
import type { StellaSandboxMcpBinding } from "../../sandbox";
import type { BrowserBridge } from "./bridge";
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

type HeldRun = {
  secret: Buffer;
  threadId: string;
  approvals: DesktopRunnerApprovalMode;
  approve: ApproveAction;
};

export type LocalBrowserMcp = {
  /** `http://127.0.0.1:<port>`, for logs and tests. */
  readonly origin: string;
  /** The binding a run's harness configuration receives. */
  register: (run: {
    runId: string;
    threadId: string;
    /** The run's approval mode: which browser steps wait for the member. */
    approvals: DesktopRunnerApprovalMode;
    /** Asks the run's member to allow one browser step. */
    approve: ApproveAction;
  }) => StellaSandboxMcpBinding;
  /** Ends the run's access and stops its command in the extension. */
  unregister: (runId: string) => void;
  stop: () => Promise<void>;
};

const BEARER = /^Bearer (\S+)$/u;

const presentsSecret = (request: Request, held: HeldRun) => {
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

export const startLocalBrowserMcp = ({
  bridge,
  version,
}: {
  bridge: BrowserBridge;
  /** The sidecar's version, reported as the server's. */
  version: string;
}): LocalBrowserMcp => {
  const runs = new Map<string, HeldRun>();
  /** Each chat's page state; kept while any run of the chat is held. */
  const sessions = new Map<
    string,
    ReturnType<typeof createLocalBrowserSession>
  >();
  const listener = { host: "" };

  const sessionFor = (threadId: string) => {
    const existing = sessions.get(threadId);
    if (existing !== undefined) {
      return existing;
    }
    const created = createLocalBrowserSession();
    sessions.set(threadId, created);
    return created;
  };

  const answer = async (
    runId: string,
    held: HeldRun,
    message: v.InferOutput<typeof rpcRequestSchema>,
    signal: AbortSignal,
  ): Promise<Response> => {
    const { id, method } = message;
    if (id === undefined) {
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
            "Unknown tool: call open, snapshot, click or type.",
          );
        }
        const result = await sessionFor(held.threadId).call(
          params.output.name,
          params.output.arguments,
          {
            approvals: held.approvals,
            approve: held.approve,
            signal,
            send: async (command, observedTab) =>
              await bridge.request(
                {
                  command,
                  controllerId: held.threadId,
                  observedTab,
                  toolCallId: crypto.randomUUID(),
                  turnId: runId,
                },
                signal,
              ),
          },
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
      const runId = pathname.startsWith(ROUTE_PREFIX)
        ? decodeURIComponent(pathname.slice(ROUTE_PREFIX.length))
        : null;
      const held = runId === null ? undefined : runs.get(runId);
      if (runId === null || held === undefined) {
        return refusal(404);
      }
      if (!presentsSecret(request, held)) {
        return refusal(401);
      }
      if (request.method !== "POST") {
        return new Response(null, { headers: { allow: "POST" }, status: 405 });
      }
      const body = await readBody(request);
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
      return await answer(runId, held, message.output, request.signal);
    },
  });
  const port =
    server.port ?? panic("The browser MCP listener has no TCP port.");
  listener.host = `127.0.0.1:${port}`;
  const origin = `http://${listener.host}`;

  return {
    origin,
    register: ({ approvals, approve, runId, threadId }) => {
      const secret = Buffer.from(
        crypto.getRandomValues(new Uint8Array(SECRET_BYTES)),
      ).toString("base64url");
      runs.set(runId, {
        approvals,
        approve,
        secret: Buffer.from(secret),
        threadId,
      });
      return {
        serverName: LOCAL_BROWSER_MCP_SERVER_NAME,
        url: `${origin}${ROUTE_PREFIX}${encodeURIComponent(runId)}`,
        token: secret,
      };
    },
    unregister: (runId) => {
      const held = runs.get(runId);
      runs.delete(runId);
      if (held === undefined) {
        return;
      }
      bridge.cancel({ controllerId: held.threadId, turnId: runId });
      if (
        ![...runs.values()].some(({ threadId }) => threadId === held.threadId)
      ) {
        sessions.delete(held.threadId);
      }
    },
    stop: async () => {
      runs.clear();
      sessions.clear();
      await server.stop(true);
    },
  };
};
