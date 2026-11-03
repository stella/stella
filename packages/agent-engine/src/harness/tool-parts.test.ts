import { describe, expect, test } from "bun:test";

import { BUILT_IN_CHAT_TOOL_POLICY_KINDS } from "@stll/api-contract/chat-tool-policy";
import { MCP_CHAT_TOOL_POLICY_KINDS } from "@stll/api-contract/mcp-chat-tool-policy";
import { STELLA_MCP_TOOL_NAMES } from "@stll/api-contract/mcp-tool-names";

import {
  HARNESS_TOOL_NAMES,
  mcpToolCallName,
  unsupportedItem,
} from "./tool-parts";

const STELLA = "stella";

const isChatTool = (name: string) =>
  Object.hasOwn(BUILT_IN_CHAT_TOOL_POLICY_KINDS, name);

describe("MCP tool call names", () => {
  test("a stella tool never takes the name of a different chat tool", () => {
    for (const tool of STELLA_MCP_TOOL_NAMES) {
      const name = mcpToolCallName({
        server: STELLA,
        tool,
        stellaServer: STELLA,
      });
      if (name === tool && isChatTool(name)) {
        expect(Object.hasOwn(MCP_CHAT_TOOL_POLICY_KINDS, name)).toBe(true);
      }
      expect([tool, `mcp__${STELLA}__${tool}`]).toContain(name);
    }
  });

  test("every chat-projected stella tool keeps its chat name", () => {
    const projected = Object.keys(MCP_CHAT_TOOL_POLICY_KINDS);
    expect(projected.length).toBeGreaterThan(0);
    for (const tool of projected) {
      expect(
        mcpToolCallName({ server: STELLA, tool, stellaServer: STELLA }),
      ).toBe(tool);
    }
  });

  test("a registry name that is a hand-written chat tool keeps its server prefix", () => {
    // The fixture must reach the collision: a registry tool whose name is a
    // different chat tool.
    expect(STELLA_MCP_TOOL_NAMES).toContain("read_document");
    expect(isChatTool("read_document")).toBe(true);
    expect(Object.hasOwn(MCP_CHAT_TOOL_POLICY_KINDS, "read_document")).toBe(
      false,
    );
    expect(
      mcpToolCallName({
        server: STELLA,
        tool: "read_document",
        stellaServer: STELLA,
      }),
    ).toBe("mcp__stella__read_document");
  });

  test("a registry read with no chat tool of its name is named by the registry", () => {
    expect(isChatTool("search_case_law")).toBe(false);
    expect(
      mcpToolCallName({
        server: STELLA,
        tool: "search_case_law",
        stellaServer: STELLA,
      }),
    ).toBe("search_case_law");
  });

  test("connector tools and tools outside the registry keep the MCP form", () => {
    expect(
      mcpToolCallName({
        server: "docs",
        tool: "search_case_law",
        stellaServer: STELLA,
      }),
    ).toBe("mcp__docs__search_case_law");
    expect(
      mcpToolCallName({
        server: STELLA,
        tool: "skill_lease_review",
        stellaServer: STELLA,
      }),
    ).toBe("mcp__stella__skill_lease_review");
    // The binding's server name decides, not the literal "stella".
    expect(
      mcpToolCallName({
        server: STELLA,
        tool: "search_case_law",
        stellaServer: "stella_run",
      }),
    ).toBe("mcp__stella__search_case_law");
  });
});

describe("harness activity names", () => {
  test("no harness-native name is a chat tool or a stella tool", () => {
    const registry = new Set<string>(STELLA_MCP_TOOL_NAMES);
    for (const name of Object.values(HARNESS_TOOL_NAMES)) {
      expect(isChatTool(name)).toBe(false);
      expect(registry.has(name)).toBe(false);
    }
  });

  test("an unsupported item carries only its kind, bounded", () => {
    const { toolCall, result } = unsupportedItem("item-1", "x".repeat(500));
    expect(toolCall.name).toBe(HARNESS_TOOL_NAMES.unsupportedItem);
    expect(toolCall.input).toEqual({ itemType: "x".repeat(128) });
    expect(result.status).toBe("failed");
    expect(JSON.parse(result.content)).toMatchObject({
      error: { code: "unsupported_item" },
    });
  });
});
