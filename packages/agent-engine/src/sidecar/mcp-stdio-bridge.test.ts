import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { isLoopbackHttpUrl, runMcpStdioBridge } from "./mcp-stdio-bridge";

const chunksOf = async function* (text: string) {
  yield new TextEncoder().encode(text);
};

describe("mcp-stdio-bridge", () => {
  test("accepts loopback HTTP URLs and refuses foreign or credentialed URLs", () => {
    expect(isLoopbackHttpUrl("http://127.0.0.1:4321/mcp/abc")).toBe(true);
    expect(isLoopbackHttpUrl("http://localhost:4321/mcp/abc")).toBe(true);
    expect(isLoopbackHttpUrl("http://[::1]:4321/mcp/abc")).toBe(true);
    expect(isLoopbackHttpUrl("https://127.0.0.1:4321/mcp/abc")).toBe(false);
    expect(isLoopbackHttpUrl("http://user:pass@127.0.0.1:4321/mcp/abc")).toBe(
      false,
    );
    expect(isLoopbackHttpUrl("http://example.com/mcp/abc")).toBe(false);
  });

  test("forwards JSON-RPC requests with bearer token, session id, JSON and SSE responses", async () => {
    const seenHeaders: Record<string, string | null>[] = [];
    let call = 0;
    const fetchImpl = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const headers = new Headers(init?.headers);
      seenHeaders.push({
        authorization: headers.get("authorization"),
        session: headers.get("mcp-session-id"),
      });
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "sess-1",
            },
          },
        );
      }
      if (call === 2) {
        return new Response(null, { status: 202 });
      }
      return new Response(
        'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n',
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    };

    const lines: string[] = [];
    const result = await runMcpStdioBridge({
      url: "http://127.0.0.1:9999/mcp/run-1",
      token: "secret-tok",
      input: chunksOf(
        `${[
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }),
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        ].join("\n")}\n`,
      ),
      output: (line) => {
        lines.push(line);
      },
      fetchImpl,
    });

    expect(Result.isOk(result)).toBe(true);
    expect(seenHeaders).toEqual([
      { authorization: "Bearer secret-tok", session: null },
      { authorization: "Bearer secret-tok", session: "sess-1" },
      { authorization: "Bearer secret-tok", session: "sess-1" },
    ]);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
      { jsonrpc: "2.0", id: 2, result: { tools: [] } },
    ]);
  });

  test("returns a JSON-RPC error when the proxy responds with an HTTP error", async () => {
    const fetchImpl = async () => new Response("unauthorized", { status: 401 });
    const lines: string[] = [];
    await runMcpStdioBridge({
      url: "http://127.0.0.1:9999/mcp/run-1",
      token: "bad",
      input: chunksOf(
        `${JSON.stringify({ jsonrpc: "2.0", id: "req-9", method: "tools/list" })}\n`,
      ),
      output: (line) => {
        lines.push(line);
      },
      fetchImpl,
    });
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        jsonrpc: "2.0",
        id: "req-9",
        error: {
          code: -32_603,
          message: "stella's MCP proxy answered HTTP 401.",
        },
      },
    ]);
  });
});
