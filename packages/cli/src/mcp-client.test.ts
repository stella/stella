import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { respondToMcpLifecycle } from "../tests/mcp-test-lifecycle.js";
import { CLI_VERSION } from "./generated/cli-version.js";
import {
  callTool,
  fetchToolsListRaw,
  listResources,
  listTools,
  readResource,
} from "./mcp-client.js";

const toolsListBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: { tools: [] },
});

describe("fetchToolsListRaw authenticated scope evidence", () => {
  test("returns effective scopes and exact scope-omitted tools attested by the server", async () => {
    const authorizationHeaders: (string | null)[] = [];
    let initializeVersion: string | undefined;
    const methods: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.method === "GET") {
          return new Response(null, { status: 405 });
        }
        authorizationHeaders.push(request.headers.get("authorization"));
        const body: {
          method?: string;
          params?: { clientInfo?: { version?: string } };
        } = JSON.parse(await request.text());
        if (body.method !== undefined) {
          methods.push(body.method);
        }
        if (body.method === "initialize") {
          initializeVersion = body.params?.clientInfo?.version;
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
        expect(authorizationHeaders).toEqual(
          methods.map(() => "Bearer test-token"),
        );
        expect(initializeVersion).toBe(CLI_VERSION);
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

  test("does not buffer a persistent SSE tools/list response for evidence", async () => {
    const encoder = new TextEncoder();
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.method === "GET") {
          return new Response(null, { status: 405 });
        }
        const body: { id?: string | number; method?: string } = JSON.parse(
          await request.text(),
        );
        const lifecycle = respondToMcpLifecycle(body);
        if (lifecycle !== null) {
          return lifecycle;
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `event: message\ndata: ${JSON.stringify({
                    jsonrpc: "2.0",
                    id: body.id,
                    result: { tools: [] },
                  })}\n\n`,
                ),
              );
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });

    try {
      const result = await Promise.race([
        fetchToolsListRaw({
          serverUrl: `http://localhost:${server.port}`,
          token: "test-token",
          timeoutMs: 100,
        }),
        Bun.sleep(500).then(() => "hung" as const),
      ]);

      expect(result).not.toBe("hung");
      if (result === "hung") {
        throw new Error("tools/list buffered the persistent SSE body");
      }
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.message).toContain(
          "did not expose tools/list evidence",
        );
      }
    } finally {
      void server.stop(true);
    }
  });
});

describe("resources/read content policy", () => {
  test("rejects binary resources instead of returning a payload-less entry", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.method === "GET") {
          return new Response(null, { status: 405 });
        }
        const body: { id?: string | number; method?: string } = JSON.parse(
          await request.text(),
        );
        const lifecycle = respondToMcpLifecycle(body);
        if (lifecycle !== null) {
          return lifecycle;
        }
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            contents: [
              {
                blob: "AA==",
                mimeType: "application/octet-stream",
                uri: "stella://binary",
              },
            ],
          },
        });
      },
    });

    try {
      const result = await readResource({
        serverUrl: `http://localhost:${server.port}`,
        token: "test-token",
        uri: "stella://binary",
      });

      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.message).toContain(
          "Binary MCP resource stella://binary is not supported",
        );
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

describe("metadata operation timeout policy", () => {
  test("forwards a caller deadline to tool and resource SDK operations", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.method === "GET") {
          return new Response(null, { status: 405 });
        }
        const body: { id?: string | number; method?: string } = JSON.parse(
          await request.text(),
        );
        const lifecycle = respondToMcpLifecycle(body);
        if (lifecycle !== null) {
          return lifecycle;
        }
        await Bun.sleep(20);
        let result: Record<string, unknown>;
        if (body.method === "tools/list") {
          result = { tools: [] };
        } else if (body.method === "resources/list") {
          result = { resources: [] };
        } else {
          result = {
            contents: [{ uri: "stella://about", text: "about stella" }],
          };
        }
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      },
    });
    const connection = {
      serverUrl: `http://localhost:${server.port}`,
      token: "test-token",
    };
    try {
      expect(
        Result.isError(await listTools({ ...connection, timeoutMs: 1 })),
      ).toBe(true);
      expect(
        Result.isOk(await listTools({ ...connection, timeoutMs: 100 })),
      ).toBe(true);
      expect(
        Result.isError(await listResources({ ...connection, timeoutMs: 1 })),
      ).toBe(true);
      expect(
        Result.isOk(await listResources({ ...connection, timeoutMs: 100 })),
      ).toBe(true);
      expect(
        Result.isError(
          await readResource({
            ...connection,
            timeoutMs: 1,
            uri: "stella://about",
          }),
        ),
      ).toBe(true);
      expect(
        Result.isOk(
          await readResource({
            ...connection,
            timeoutMs: 100,
            uri: "stella://about",
          }),
        ),
      ).toBe(true);
    } finally {
      void server.stop(true);
    }
  });
});
