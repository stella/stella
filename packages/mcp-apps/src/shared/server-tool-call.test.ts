import type { App } from "@modelcontextprotocol/ext-apps";
import { describe, expect, test } from "bun:test";

import { CASE_LAW_RESULTS_APP } from "../manifest";
import type { AppFailure } from "./app-error";
import { createPresentationBridge } from "./bridge";
import { callAppServerTool } from "./server-tool-call";

const REFUSAL = {
  error: {
    code: "validation_error",
    message: "Invalid length: Expected >=1 but received 0",
    requestId: "req_server_receipt",
    issues: [{ path: "queries.0", message: "Expected >=1" }],
  },
};

/** The JSON-RPC error a host's client raises: `MCP error <code>: <message>` with `code` and `data`. */
const jsonRpcError = (code: number, message: string, data?: unknown) =>
  Object.assign(new Error(`MCP error ${String(code)}: ${message}`), {
    name: "McpError",
    code,
    data,
  });

const searchThroughHost = async (callServerTool: App["callServerTool"]) => {
  const bridge = createPresentationBridge({
    manifest: CASE_LAW_RESULTS_APP,
    parse: () => ({}),
    host: {
      callServerTool,
      addEventListener: () => {},
      removeEventListener: () => {},
      getHostContext: () => ({}),
      getHostCapabilities: () => undefined,
      connect: async () => {},
      openLink: async () => ({}),
      requestDisplayMode: async () => ({ mode: "inline" }),
      onteardown: undefined,
    },
  });
  await bridge.call({
    name: "search_case_law",
    arguments: { queries: ["smlouva"], country: "CZE" },
  });
  const result = bridge.getSnapshot().result;
  if (result.status !== "error") {
    throw new Error(`Expected a failed search, got ${result.status}`);
  }
  return result.failure;
};

const SERVER_REFUSAL: AppFailure = {
  type: "invalid_arguments",
  requestId: "req_server_receipt",
  retryable: false,
  fields: ["queries.0"],
  toolCode: "validation_error",
};

describe("server tool calls through a host", () => {
  test("a returned tool error fails with the server's type and receipt", async () => {
    const failure = await searchThroughHost(async () => ({
      isError: true,
      content: [{ type: "text", text: JSON.stringify(REFUSAL) }],
    }));
    expect(failure).toEqual(SERVER_REFUSAL);
  });

  test("a host that rejects with the tool error as JSON-RPC data fails the same way", async () => {
    for (const data of [
      REFUSAL,
      {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(REFUSAL) }],
      },
      { isError: true, structuredContent: REFUSAL, content: [] },
    ]) {
      const failure = await searchThroughHost(async () => {
        throw jsonRpcError(-32_603, "Tool call failed", data);
      });
      expect(failure).toEqual(SERVER_REFUSAL);
    }
  });

  test("a host that rejects with the tool error serialized in its message fails the same way", async () => {
    for (const message of [
      jsonRpcError(-32_603, JSON.stringify(REFUSAL)),
      new Error(JSON.stringify(REFUSAL)),
    ]) {
      const failure = await searchThroughHost(async () => {
        throw message;
      });
      expect(failure).toEqual(SERVER_REFUSAL);
    }
  });

  test("a rejection without a server answer stays an unreachable server with a local receipt", async () => {
    for (const rejection of [
      new Error("Request timed out"),
      jsonRpcError(-32_001, "Request timed out"),
      jsonRpcError(-32_603, "Tool call failed", { reason: "host policy" }),
      jsonRpcError(-32_603, "{not json"),
      jsonRpcError(-32_603, JSON.stringify({ error: "no code" })),
    ]) {
      const failure = await searchThroughHost(async () => {
        throw rejection;
      });
      expect(failure).toMatchObject({
        type: "unavailable",
        retryable: true,
        fields: [],
      });
      expect(failure.requestId).toMatch(/^app-[0-9a-f]{12}-\d+$/u);
    }
  });

  test("the rejection is kept for a caller that reports it", async () => {
    const rejection = new Error("Request timed out");
    expect(
      await callAppServerTool(
        {
          callServerTool: async () => {
            throw rejection;
          },
        },
        { name: "search_case_law", arguments: {} },
      ),
    ).toEqual({ status: "unreachable", error: rejection });
  });
});
