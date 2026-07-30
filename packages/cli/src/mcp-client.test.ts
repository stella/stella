import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { fetchToolsListRaw } from "./mcp-client.js";

const toolsListBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: { tools: [] },
});

describe("fetchToolsListRaw authenticated scope evidence", () => {
  test("returns the effective scopes attested by the server", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(toolsListBody, {
          headers: {
            "Content-Type": "application/json",
            "x-stella-scopes": "stella:read stella:search",
          },
        }),
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
      }
    } finally {
      void server.stop(true);
    }
  });

  test("leaves scope evidence absent for an older unattested server", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(toolsListBody, {
          headers: { "Content-Type": "application/json" },
        }),
    });

    try {
      const result = await fetchToolsListRaw({
        serverUrl: `http://localhost:${server.port}`,
        token: "test-token",
      });

      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value.grantedScopes).toBeUndefined();
      }
    } finally {
      void server.stop(true);
    }
  });
});
