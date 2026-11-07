import { describe, expect, test } from "bun:test";

import { MCP_WEB_HANDOFF_TOOL_NAME } from "@stll/api-contract/mcp-web-handoff";

import {
  createStellaAppToolCaller,
  openStellaAppLink,
  STELLA_APP_HOST_CAPABILITIES,
  stellaAppDirectory,
  stellaAppHostContext,
  stellaAppToolResult,
} from "@/components/chat/stella-mcp-app-bridge";

const unsafeScriptUrl = ["java", "script:alert(1)"].join("");

const recordingServer = (answer: unknown) => {
  const requests: unknown[] = [];
  return {
    requests,
    call: async (request: unknown) => {
      requests.push(request);
      return await Promise.resolve(answer);
    },
  };
};

describe("the host side of a stella app's bridge", () => {
  test("hands the app the call it presents as an MCP tool result", () => {
    const structuredContent = { results: [{ id: "decision-one" }] };
    expect(
      stellaAppToolResult({
        input: { query: "unfair dismissal" },
        result: { structuredContent },
      }),
    ).toEqual({
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    });
  });

  test("forwards an app's tool call to the server and returns its answer", async () => {
    const answer = {
      content: [{ type: "text", text: "{}" }],
      structuredContent: {},
    };
    const server = recordingServer(answer);
    const callTool = createStellaAppToolCaller(server.call);
    expect(
      await callTool({
        name: "open_case_law_decision",
        arguments: { decision_id: "decision-one" },
      }),
    ).toEqual(answer);
    expect(await callTool({ name: "list_case_law_courts" })).toEqual(answer);
    expect(server.requests).toEqual([
      {
        name: "open_case_law_decision",
        arguments: { decision_id: "decision-one" },
      },
      { name: "list_case_law_courts", arguments: {} },
    ]);
  });

  test("declines the link handoff without asking the server", async () => {
    const server = recordingServer({ content: [] });
    const result = await createStellaAppToolCaller(server.call)({
      name: MCP_WEB_HANDOFF_TOOL_NAME,
      arguments: { url: "https://example.test/decision" },
    });
    expect(result.isError).toBe(true);
    expect(server.requests).toEqual([]);
  });

  test("answers an unreachable server or a foreign answer as a tool error", async () => {
    const unreachable = createStellaAppToolCaller(
      async () => await Promise.reject(new Error("offline")),
    );
    expect((await unreachable({ name: "search_case_law" })).isError).toBe(true);
    for (const answer of [
      null,
      "text",
      { content: [{ type: "image", data: "AAAA" }] },
      { content: [], structuredContent: [] },
    ]) {
      const foreign = createStellaAppToolCaller(recordingServer(answer).call);
      expect((await foreign({ name: "search_case_law" })).isError).toBe(true);
    }
  });

  test("opens only web links", () => {
    const opened: string[] = [];
    const open = (href: string) => {
      opened.push(href);
    };
    expect(openStellaAppLink("https://example.test/decision", open)).toEqual(
      {},
    );
    for (const url of [
      unsafeScriptUrl,
      "file:///etc/passwd",
      "mailto:someone@example.test",
      "not a url",
    ]) {
      expect(openStellaAppLink(url, open)).toEqual({ isError: true });
    }
    expect(opened).toEqual(["https://example.test/decision"]);
  });

  test("describes an inline host that runs tools and opens links", () => {
    expect(stellaAppHostContext({ theme: "dark", locale: "cs" })).toEqual({
      theme: "dark",
      locale: "cs",
      displayMode: "inline",
      availableDisplayModes: ["inline"],
    });
    expect(STELLA_APP_HOST_CAPABILITIES).toEqual({
      serverTools: {},
      openLinks: {},
    });
  });

  test("reads an app's bundle name from its resource", () => {
    expect(stellaAppDirectory("ui://stella/case-law-results")).toBe(
      "case-law-results",
    );
    expect(stellaAppDirectory("ui://widget")).toBeNull();
  });
});
