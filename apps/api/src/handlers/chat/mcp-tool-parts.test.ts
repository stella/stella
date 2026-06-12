import { describe, expect, it } from "bun:test";

import { isExternalMcpToolPart } from "@/api/handlers/chat/mcp-tool-parts";

describe("isExternalMcpToolPart", () => {
  it("recognizes TanStack external MCP tool calls", () => {
    expect(
      isExternalMcpToolPart({
        name: "mcp__salvia__search_decisions",
        type: "tool-call",
      }),
    ).toBe(true);
  });

  it("ignores legacy dynamic tool parts", () => {
    expect(
      isExternalMcpToolPart({
        toolName: "mcp__salvia__search_decisions",
        type: "dynamic-tool",
      }),
    ).toBe(false);
  });

  it("ignores non-MCP tool call parts", () => {
    expect(
      isExternalMcpToolPart({
        name: "create-document",
        type: "tool-call",
      }),
    ).toBe(false);
  });
});
