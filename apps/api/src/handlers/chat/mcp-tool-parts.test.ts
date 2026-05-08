import { describe, expect, it } from "bun:test";

import { isExternalMcpToolPart } from "@/api/handlers/chat/mcp-tool-parts";

describe("isExternalMcpToolPart", () => {
  it("recognizes typed and dynamic external MCP parts", () => {
    expect(
      isExternalMcpToolPart({ type: "tool-mcp__salvia__search_decisions" }),
    ).toBe(true);
    expect(
      isExternalMcpToolPart({
        toolName: "mcp__salvia__search_decisions",
        type: "dynamic-tool",
      }),
    ).toBe(true);
  });

  it("ignores non-MCP dynamic tool parts", () => {
    expect(
      isExternalMcpToolPart({
        toolName: "create-document",
        type: "dynamic-tool",
      }),
    ).toBe(false);
  });
});
