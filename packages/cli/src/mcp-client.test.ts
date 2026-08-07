import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { callTool, fetchToolsListRaw } from "./mcp-client.js";
import { respondToMcpLifecycle } from "./mcp-test-lifecycle.js";

const toolsListBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: { tools: [] },
});

describe("fetchToolsListRaw authenticated scope evidence", () => {
  test("returns effective scopes and exact scope-omitted tools attested by the server", async () => {
    const methods: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.method === "GET") {
          return new Response(null, { status: 405 });
        }
        const body: { method?: string } = JSON.parse(await request.text());
        if (body.method !== undefined) {
          methods.push(body.method);
        }
        const lifecycle = respondToMcpLifecycle(body);
        return (
          lifecycle ??
          new Response(toolsListBody, {
            headers: {
              "Content-Type": "application/json",
              "x-stella-scopes": "stella:read stella:search",
              "x-stella-scope-omitted-tools": "save_filled_template",
            },
          })
        );
      },
    });

    try {
      const result = await fetchToolsListRaw({
        serverUrl: `http://localhost:${server.port}`,
        token: "test-token",
      });

      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value.grantedScopes).toEqual([
          "stella:read",
          "stella:search",
        ]);
        expect(result.value.scopeOmittedTools).toEqual([
          "save_filled_template",
        ]);
        expect(methods).toEqual([
          "initialize",
          "notifications/initialized",
          "tools/list",
        ]);
      }
    } finally {
      void server.stop(true);
    }
  });

  test("leaves scope evidence absent for an older unattested server", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.method === "GET") {
          return new Response(null, { status: 405 });
        }
        const body: { method?: string } = JSON.parse(await request.text());
        const lifecycle = respondToMcpLifecycle(body);
        return (
          lifecycle ??
          new Response(toolsListBody, {
            headers: { "Content-Type": "application/json" },
          })
        );
      },
    });

    try {
      const result = await fetchToolsListRaw({
        serverUrl: `http://localhost:${server.port}`,
        token: "test-token",
      });

      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value.grantedScopes).toBeUndefined();
        expect(result.value.scopeOmittedTools).toBeUndefined();
      }
    } finally {
      void server.stop(true);
    }
  });
});

describe("tools/call timeout policy", () => {
  test("a tool-specific finite deadline can exceed the generic deadline", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.method === "GET") {
          return new Response(null, { status: 405 });
        }
        const body: { method?: string } = JSON.parse(await request.text());
        const lifecycle = respondToMcpLifecycle(body);
        if (lifecycle !== null) {
          return lifecycle;
        }
        await Bun.sleep(20);
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "ok" }] },
        });
      },
    });
    const input = {
      serverUrl: `http://localhost:${server.port}`,
      token: "test-token",
      name: "save_filled_template",
      args: {},
    };

    try {
      expect(Result.isError(await callTool({ ...input, timeoutMs: 1 }))).toBe(
        true,
      );
      expect(Result.isOk(await callTool({ ...input, timeoutMs: 100 }))).toBe(
        true,
      );
    } finally {
      void server.stop(true);
    }
  });
});
