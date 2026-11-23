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
 * Extracts complete `data:` payloads from an SSE stream and writes each
 * non-empty JSON payload as a single line.
 */
const writeSsePayloads = (text: string, output: (line: string) => void) => {
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
  for (const rawLine of text.split(/\r?\n/u)) {
    if (rawLine === "") {
      flush();
      continue;
    }
    if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice(5).trimStart());
    }
  }
  flush();
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
  let oversizedExceeded = false;

  const isCancellationNotification = (trimmed: string): boolean => {
    const parsed = Result.try((): unknown => JSON.parse(trimmed));
    return (
      Result.isOk(parsed) &&
      typeof parsed.value === "object" &&
      parsed.value !== null &&
      Reflect.get(parsed.value, "method") === "notifications/cancelled"
    );
  };

  const forward = async (line: string) => {
    const trimmed = line.trim();
    if (trimmed === "") {
      return;
    }
    const id = requestIdOf(trimmed);
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
      const body = await Result.tryPromise(async () => await res.text());
      if (Result.isError(body)) {
        if (id !== null) {
          output(jsonRpcErrorLine(id, "Could not read stella's MCP response."));
        }
        return;
      }
      if (!res.ok) {
        if (id !== null) {
          output(
            jsonRpcErrorLine(
              id,
              `stella's MCP proxy answered HTTP ${String(res.status)}.`,
            ),
          );
        }
        return;
      }
      const contentType = res.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("text/event-stream")) {
        writeSsePayloads(body.value, output);
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
      if (isCancellationNotification(line.trim())) {
        const task = forward(line).finally(() => {
          outOfBand.delete(task);
        });
        outOfBand.add(task);
        return;
      }
      queue = queue.then(async () => {
        await forward(line);
        return undefined;
      });
    },
    oversized: () => {
      oversizedExceeded = true;
    },
  });

  for await (const chunk of input) {
    lines.push(chunk);
    if (oversizedExceeded) {
      break;
    }
  }
  lines.end();
  await queue;
  await Promise.all(outOfBand);
  if (oversizedExceeded) {
    return Result.err("MCP stdio message exceeded the maximum line size.");
  }
  return Result.ok();
};
