import type { App } from "@modelcontextprotocol/ext-apps";
import { describe, expect, test } from "bun:test";

import { MCP_WEB_HANDOFF_TOOL_NAME } from "@stll/api-contract/mcp-web-handoff";

import { openPresentationLink, parseAppToolPayload } from "./bridge";

describe("MCP app tool payloads", () => {
  test("structured content takes precedence over text", () => {
    const payload = { result: { id: "123" } };
    expect(
      parseAppToolPayload({
        structuredContent: payload,
        content: [{ type: "text", text: '{"result":null}' }],
      }),
    ).toBe(payload);
  });

  test("text-only replies parse JSON and absent or malformed payloads stay absent", () => {
    expect(
      parseAppToolPayload({
        content: [{ type: "text", text: '{"result":123}' }],
      }),
    ).toEqual({ result: 123 });
    expect(parseAppToolPayload({ content: [] })).toBeUndefined();
    expect(
      parseAppToolPayload({
        content: [{ type: "text", text: "invalid JSON" }],
      }),
    ).toBeUndefined();
  });
});

describe("MCP app web navigation", () => {
  test("refreshes at click and opens the fresh URL", async () => {
    const calls: string[] = [];
    const app = {
      callServerTool: async (request) => {
        expect(request).toEqual({
          name: MCP_WEB_HANDOFF_TOOL_NAME,
          arguments: { url: "https://app.example/law/cz/2020/1" },
        });
        calls.push("mint");
        return {
          content: [],
          structuredContent: {
            url: "https://app.example/law/cz/2020/1#sh=sh1_fresh",
          },
        };
      },
      openLink: async ({ url }) => {
        calls.push(url);
        return {};
      },
    } satisfies Pick<App, "openLink" | "callServerTool">;
    await openPresentationLink({
      app,
      url: "https://app.example/law/cz/2020/1#sh=sh1_previous",
      fail: () => expect.unreachable("Unexpected navigation refusal"),
    });
    expect(calls).toEqual([
      "mint",
      "https://app.example/law/cz/2020/1#sh=sh1_fresh",
    ]);
  });

  test("opens the plain URL when the host declines the tool", async () => {
    const opened: string[] = [];
    const app = {
      callServerTool: async () => ({ content: [], isError: true }),
      openLink: async ({ url }) => {
        opened.push(url);
        return {};
      },
    } satisfies Pick<App, "openLink" | "callServerTool">;
    await openPresentationLink({
      app,
      url: "https://app.example/law/cz/2020/1#section=2&sh=sh1_previous",
      fail: () => expect.unreachable("Unexpected navigation refusal"),
    });
    expect(opened).toEqual(["https://app.example/law/cz/2020/1#section=2"]);
  });

  test("opens the plain URL when the minted structured content is malformed", async () => {
    const opened: string[] = [];
    const app = {
      callServerTool: async () => ({ content: [], structuredContent: null }),
      openLink: async ({ url }) => {
        opened.push(url);
        return {};
      },
    } satisfies Pick<App, "openLink" | "callServerTool">;
    await openPresentationLink({
      app,
      url: "https://app.example/law/cz/2020/1#section=2",
      fail: () => expect.unreachable("Unexpected navigation refusal"),
    });
    expect(opened).toEqual(["https://app.example/law/cz/2020/1#section=2"]);
  });
});
