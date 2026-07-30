import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { fetchToolsListRaw } from "./mcp-client.js";

const toolsListBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: { tools: [] },
});

describe("fetchToolsListRaw authenticated scope evidence", () => {
  test("returns effective scopes and exact scope-omitted tools attested by the server", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(toolsListBody, {
          headers: {
            "Content-Type": "application/json",
            "x-stella-scopes": "stella:read stella:search",
            "x-stella-scope-omitted-tools": "save_filled_template",
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
        expect(result.value.scopeOmittedTools).toEqual([
          "save_filled_template",
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
        expect(result.value.scopeOmittedTools).toBeUndefined();
      }
    } finally {
      void server.stop(true);
    }
  });
});
