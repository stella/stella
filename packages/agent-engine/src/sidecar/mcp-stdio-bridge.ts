import { Result } from "better-result";

import { createLineReader } from "../harness/json-lines";

/**
 * Stdio-to-HTTP bridge for MCP clients (such as ACP agents) that only speak
 * stdio MCP and cannot connect to stella's local HTTP MCP proxy directly.
 *
 * Each newline-delimited JSON-RPC message on stdin is forwarded as an HTTP
 * POST to the local `McpProxy` endpoint with its bearer token, and each
 * JSON-RPC response (plain JSON or SSE `data:` event) is written back as a
 * single line on stdout.
 */

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export type McpStdioBridgeOptions = {
  url: string;
  token: string;
  input: AsyncIterable<Uint8Array>;
  output: (line: string) => void;
  fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
};

/** Only local loopback HTTP endpoints are accepted (stella's `McpProxy`). */
export const isLoopbackHttpUrl = (raw: string): boolean => {
  const parsed = Result.try(() => new URL(raw));
  if (Result.isError(parsed)) {
    return false;
  }
  const { protocol, hostname, username, password } = parsed.value;
  return (
    protocol === "http:" &&
    username === "" &&
    password === "" &&
    LOOPBACK_HOSTS.has(hostname.toLowerCase())
  );
};

const requestIdOf = (line: string): string | number | null => {
  const parsed = Result.try((): unknown => JSON.parse(line));
  if (
    Result.isError(parsed) ||
    typeof parsed.value !== "object" ||
    parsed.value === null
  ) {
    return null;
  }
  const id: unknown = Reflect.get(parsed.value, "id");
  return typeof id === "string" || typeof id === "number" ? id : null;
};

const jsonRpcErrorLine = (id: string | number, message: string): string =>
  `${JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32_603, message },
  })}\n`;

/**
 * Writes each complete `data:` payload of an SSE stream as a single line as
 * soon as its event ends, so a server request sent on the stream before the
 * final response reaches the agent while the stream stays open.
 */
const createSseWriter = (output: (line: string) => void) => {
  let pending = "";
  let dataLines: string[] = [];
  const flush = () => {
    if (dataLines.length === 0) {
      return;
    }
    const payload = dataLines.join("\n").trim();
    dataLines = [];
    if (payload === "") {
      return;
    }
    const compact = Result.try(() => JSON.stringify(JSON.parse(payload)));
    output(
      `${Result.isOk(compact) ? compact.value : payload.replace(/\r?\n/gu, " ")}\n`,
    );
  };
  const line = (rawLine: string) => {
    if (rawLine === "") {
      flush();
      return;
    }
    if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice(5).trimStart());
    }
  };
  return {
    push: (text: string) => {
      const lines = `${pending}${text}`.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const rawLine of lines) {
        line(rawLine);
      }
    },
    end: () => {
      if (pending !== "") {
        line(pending);
        pending = "";
      }
      flush();
    },
  };
};

type BridgeMessage =
  | { kind: "request"; id: string | number }
  | { kind: "cancellation"; requestId: string | number | null }
  | { kind: "response" }
  | { kind: "other" };

/**
 * Requests wait their turn; a response or a cancellation from the agent goes
 * out at once, since the request it answers may hold the queue open.
 */
const bridgeMessageOf = (trimmed: string): BridgeMessage => {
  const parsed = Result.try((): unknown => JSON.parse(trimmed));
  if (
    Result.isError(parsed) ||
    typeof parsed.value !== "object" ||
    parsed.value === null
  ) {
    return { kind: "other" };
  }
  const message = parsed.value;
  const method: unknown = Reflect.get(message, "method");
  const id: unknown = Reflect.get(message, "id");
  const validId = typeof id === "string" || typeof id === "number";
  if (method === "notifications/cancelled") {
    const params: unknown = Reflect.get(message, "params");
    const requestId: unknown =
      typeof params === "object" && params !== null
        ? Reflect.get(params, "requestId")
        : null;
    return {
      kind: "cancellation",
      requestId:
        typeof requestId === "string" || typeof requestId === "number"
          ? requestId
          : null,
    };
  }
  if (typeof method === "string") {
    return validId ? { kind: "request", id } : { kind: "other" };
  }
  return validId ? { kind: "response" } : { kind: "other" };
};

export const runMcpStdioBridge = async ({
  url,
  token,
  input,
  output,
  fetchImpl = fetch,
}: McpStdioBridgeOptions): Promise<Result<void, string>> => {
  if (!isLoopbackHttpUrl(url)) {
    return Result.err("MCP bridge URL must be a loopback HTTP endpoint.");
  }
  const REQUEST_TIMEOUT_MS = 120_000;
  const state: { sessionId: string | null } = { sessionId: null };
  let queue: Promise<void> = Promise.resolve();
  const outOfBand = new Set<Promise<void>>();
  // Set from the reader's callback, so it is a field, not a narrowed local.
  const limit = { oversizedExceeded: false };

  // Requests still waiting in the queue, and those cancelled before they
  // were sent: a cancelled request never reaches the proxy.
  const queued = new Set<string | number>();
  const cancelledBeforeSending = new Set<string | number>();

  const forward = async (line: string) => {
    const trimmed = line.trim();
    if (trimmed === "") {
      return;
    }
    // Only a request is answered with an error line; the agent's own
    // responses and notifications expect no reply.
    const id =
      bridgeMessageOf(trimmed).kind === "request" ? requestIdOf(trimmed) : null;
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    if (state.sessionId !== null) {
      headers["mcp-session-id"] = state.sessionId;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await Result.tryPromise(
        async () =>
          await fetchImpl(url, {
            method: "POST",
            headers,
            body: trimmed,
            redirect: "manual",
            signal: controller.signal,
          }),
      );
      if (Result.isError(response)) {
        if (id !== null) {
          output(jsonRpcErrorLine(id, "Could not reach stella's MCP proxy."));
        }
        return;
      }
      const res = response.value;
      const nextSessionId = res.headers.get("mcp-session-id");
      if (nextSessionId !== null && nextSessionId !== "") {
        state.sessionId = nextSessionId;
      }
      if (res.status === 202 || res.status === 204) {
        return;
      }
      if (!res.ok) {
        const released = await Result.tryPromise(
          async () => await res.body?.cancel(),
        );
        if (id !== null) {
          const answered = `stella's MCP proxy answered HTTP ${String(res.status)}.`;
          output(
            jsonRpcErrorLine(
              id,
              Result.isOk(released)
                ? answered
                : `${answered} Its response could not be closed.`,
            ),
          );
        }
        return;
      }
      const contentType = res.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("text/event-stream")) {
        const sse = createSseWriter(output);
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const streamed = await Result.tryPromise(async () => {
          if (res.body === null) {
            return;
          }
          for await (const bytes of res.body) {
            sse.push(decoder.decode(bytes, { stream: true }));
          }
          sse.push(decoder.decode());
        });
        sse.end();
        if (Result.isError(streamed) && id !== null) {
          output(jsonRpcErrorLine(id, "Could not read stella's MCP response."));
        }
        return;
      }
      const body = await Result.tryPromise(async () => await res.text());
      if (Result.isError(body)) {
        if (id !== null) {
          output(jsonRpcErrorLine(id, "Could not read stella's MCP response."));
        }
        return;
      }
      const text = body.value.trim();
      if (text !== "") {
        const compact = Result.try(() => JSON.stringify(JSON.parse(text)));
        output(
          `${Result.isOk(compact) ? compact.value : text.replace(/\r?\n/gu, " ")}\n`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  };

  const lines = createLineReader({
    maxLineBytes: MAX_LINE_BYTES,
    line: (line) => {
      const message = bridgeMessageOf(line.trim());
      if (
        message.kind === "cancellation" &&
        message.requestId !== null &&
        queued.has(message.requestId)
      ) {
        // The proxy has not seen the request: it is dropped before sending,
        // so it cannot start after the agent cancelled it.
        cancelledBeforeSending.add(message.requestId);
        return;
      }
      if (message.kind === "cancellation" || message.kind === "response") {
        const task = forward(line).finally(() => {
          outOfBand.delete(task);
        });
        outOfBand.add(task);
        return;
      }
      if (message.kind === "request") {
        queued.add(message.id);
      }
      queue = queue.then(async () => {
        if (message.kind === "request") {
          queued.delete(message.id);
          if (cancelledBeforeSending.delete(message.id)) {
            return undefined;
          }
        }
        await forward(line);
        return undefined;
      });
    },
    oversized: () => {
      limit.oversizedExceeded = true;
    },
  });

  for await (const chunk of input) {
    lines.push(chunk);
    if (limit.oversizedExceeded) {
      break;
    }
  }
  lines.end();
  await queue;
  await Promise.all(outOfBand);
  if (limit.oversizedExceeded) {
    return Result.err("MCP stdio message exceeded the maximum line size.");
  }
  return Result.ok();
};
