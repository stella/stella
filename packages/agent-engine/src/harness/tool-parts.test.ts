import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { BUILT_IN_CHAT_TOOL_POLICY_KINDS } from "@stll/api-contract/chat-tool-policy";
import { MCP_CHAT_TOOL_POLICY_KINDS } from "@stll/api-contract/mcp-chat-tool-policy";
import { STELLA_MCP_TOOL_NAMES } from "@stll/api-contract/mcp-tool-names";
import { assertProperty } from "@stll/property-testing";

import {
  HARNESS_TOOL_NAMES,
  mcpToolCallName,
  nativeToolCall,
  shownToolInput,
  stepOfSubagent,
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
    expect(JSON.parse(result.content)).toEqual({ status: "failed" });
  });
});

describe("a step a subagent took", () => {
  const text = fc.string({ unit: "binary", maxLength: 1500 });
  const steps = fc.oneof(
    fc.record({
      name: fc.constant(HARNESS_TOOL_NAMES.commandExecution),
      input: fc.record({ command: text }),
    }),
    fc.record({
      name: fc.constant(HARNESS_TOOL_NAMES.fileChange),
      input: fc.record({
        changes: fc.array(
          fc.record({ path: text, kind: fc.constantFrom("add", "update") }),
          { maxLength: 60 },
        ),
      }),
    }),
    fc.record({
      name: fc.constant(HARNESS_TOOL_NAMES.webSearch),
      input: fc.record({ query: text }),
    }),
    fc.record({
      name: fc.constant(HARNESS_TOOL_NAMES.nativeTool),
      input: fc.record({
        tool: text,
        detail: fc.oneof(
          fc.record({ kind: fc.constant("read"), path: text }),
          fc.record({ kind: fc.constant("image"), path: text }),
          fc.record({ kind: fc.constant("subagent"), description: text }),
        ),
      }),
    }),
    fc.record({
      name: fc.constant(HARNESS_TOOL_NAMES.unsupportedItem),
      input: fc.record({ itemType: text }),
    }),
  );

  test("a step a subagent took shows what the same step shows on the main thread, and names the subagent", () => {
    assertProperty(
      "a step a subagent took shows what the same step shows on the main thread, and names the subagent",
      fc.property(
        steps,
        fc.string({ minLength: 1, maxLength: 64 }),
        (step, parentCallId) => {
          const call = nativeToolCall("step-1", step);
          const onMainThread = shownToolInput(call, "/workspace");
          const inSubagent = shownToolInput(
            stepOfSubagent(call, parentCallId),
            "/workspace",
          );
          expect(stepOfSubagent(call, null)).toBe(call);
          // The same bounded fields: naming a subagent neither adds to a
          // step nor cuts it differently.
          expect(inSubagent).toEqual({
            ...(typeof onMainThread === "object" ? onMainThread : {}),
            parentCallId,
          });
        },
      ),
    );
  });

  test("a call that is not a native step names no subagent", () => {
    const call = {
      id: "call-1",
      name: "mcp__docs__search",
      input: { query: "lease" },
    };
    expect(stepOfSubagent(call, "call-agent")).toBe(call);
  });
});
