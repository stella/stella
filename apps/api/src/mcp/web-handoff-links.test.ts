import { describe, expect, test } from "bun:test";

import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import type { McpRequestContext } from "./context";
import {
  DEFAULT_MCP_TOOL_DEFINITIONS,
  getStaticMcpToolDefinition,
  getStaticMcpToolHandler,
} from "./static-tool-definitions";
import { isMcpToolVisibleTo } from "./tool-visibility";
import { MCP_WEB_HANDOFF_TOOL, withWebHandoffLinks } from "./web-handoff-links";

describe("MCP app web handoff tool", () => {
  test("host registration stays outside model discovery", () => {
    const definition = getStaticMcpToolDefinition(MCP_WEB_HANDOFF_TOOL);
    expect(definition).toBeDefined();
    if (definition === undefined) {
      expect.unreachable("Missing app tool");
    }
    expect(isMcpToolVisibleTo(definition, "app")).toBe(true);
    expect(isMcpToolVisibleTo(definition, "model")).toBe(false);
    expect(
      getStaticMcpToolDefinition(MCP_WEB_HANDOFF_TOOL, "anonymized"),
    ).toBeUndefined();
    expect(
      DEFAULT_MCP_TOOL_DEFINITIONS.filter((tool) =>
        isMcpToolVisibleTo(tool, "model"),
      ).map(({ name }) => name),
    ).not.toContain(MCP_WEB_HANDOFF_TOOL);
  });

  test("credentials without OAuth retain plain links without minting", async () => {
    const result = {
      content: [],
      structuredContent: { url: "https://app.example/law/cz/2020/1" },
    };
    for (const credentialType of ["api-key", "anonymous", undefined] as const) {
      const context = asTestRaw<McpRequestContext>({ credentialType });
      expect(await withWebHandoffLinks(result, context)).toBe(result);
      const handler = getStaticMcpToolHandler(MCP_WEB_HANDOFF_TOOL);
      expect(handler).toBeDefined();
      if (handler === undefined) {
        expect.unreachable("Missing app handler");
      }
      const response = await handler({
        args: { url: "https://app.example/law/cz/2020/1" },
        context,
      });
      expect(response).toMatchObject({
        data: { url: "https://app.example/law/cz/2020/1" },
      });
    }
  });

  test("rejects malformed app requests before minting", async () => {
    const context = asTestRaw<McpRequestContext>({ credentialType: "oauth" });
    for (const input of [
      {},
      { url: 123 },
      { url: "https://app.example/law", extra: true },
    ]) {
      const handler = getStaticMcpToolHandler(MCP_WEB_HANDOFF_TOOL);
      if (handler === undefined) {
        expect.unreachable("Missing app handler");
      }
      expect(await handler({ args: input, context })).toMatchObject({
        status: "error",
        error: { code: "validation_error" },
      });
    }
  });
});
