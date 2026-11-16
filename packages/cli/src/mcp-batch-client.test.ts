import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { respondToMcpLifecycle } from "../tests/mcp-test-lifecycle.js";
import { withBatchToolClient } from "./mcp-client.js";

describe("batch MCP session", () => {
  test("negotiates once and keeps idempotency headers local to each write", async () => {
    const requests: { method: string; key: string | null }[] = [];
    const writes: string[] = [];
    const bothWrites = Promise.withResolvers<undefined>();
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.method === "GET") {
          return new Response(null, { status: 405 });
        }
        const body: {
          id: number;
          method: string;
          params?: { name: string };
        } = JSON.parse(await request.text());
        requests.push({
          method: body.method,
          key: request.headers.get("Idempotency-Key"),
        });
        const lifecycle = respondToMcpLifecycle(body);
        if (lifecycle !== null) {
          return lifecycle;
        }
        if (body.params?.name === "write") {
          writes.push(request.headers.get("Idempotency-Key") ?? "missing");
          if (writes.length === 2) {
            bothWrites.resolve(undefined);
          }
          await bothWrites.promise;
        }
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: "ok" }] },
        });
      },
    });
    try {
      const result = await withBatchToolClient({
        serverUrl: server.url.origin,
        token: "fixture-token",
        operation: async (call) =>
          await Promise.all([
            call({ name: "write", args: {}, idempotencyKey: "first" }),
            call({ name: "write", args: {}, idempotencyKey: "second" }),
            call({ name: "read", args: {} }),
          ]),
      });
      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value.every((item) => Result.isOk(item))).toBe(true);
      }
      expect(writes.toSorted()).toEqual(["first", "second"]);
      expect(requests.filter(({ method }) => method === "initialize")).toEqual([
        { method: "initialize", key: null },
      ]);
      expect(
        requests.filter(({ method }) => method === "notifications/initialized"),
      ).toEqual([{ method: "notifications/initialized", key: null }]);
      expect(requests.filter(({ key }) => key === null)).toHaveLength(3);
    } finally {
      await server.stop(true);
    }
  });

  test("retains each concurrent HTTP failure's Retry-After", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.method === "GET") {
          return new Response(null, { status: 405 });
        }
        const body: { id: number; method: string; params?: { name: string } } =
          JSON.parse(await request.text());
        const lifecycle = respondToMcpLifecycle(body);
        if (lifecycle !== null) {
          return lifecycle;
        }
        return new Response("Limited", {
          status: 429,
          headers: { "Retry-After": body.params?.name === "first" ? "2" : "7" },
        });
      },
    });
    try {
      const result = await withBatchToolClient({
        serverUrl: server.url.origin,
        token: "fixture-token",
        operation: async (call) =>
          await Promise.all([
            call({ name: "first", args: {}, idempotencyKey: "first" }),
            call({ name: "second", args: {}, idempotencyKey: "second" }),
          ]),
      });
      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(
          result.value.map((item) =>
            Result.isError(item)
              ? {
                  status: item.error.httpStatus,
                  retryAfter: item.error.retryAfter,
                }
              : { status: "unexpected success" },
          ),
        ).toEqual([
          { status: 429, retryAfter: "2" },
          { status: 429, retryAfter: "7" },
        ]);
      }
    } finally {
      await server.stop(true);
    }
  });
});
