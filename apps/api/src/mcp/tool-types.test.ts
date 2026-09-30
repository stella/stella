import { describe, test } from "bun:test";
import { expectTypeOf } from "expect-type";

import type { ActionKindDefinition } from "@/api/lib/rate-limit/action-kinds";
import type {
  AllHandlerOutputsTyped,
  HandlerOutputsMatchByName,
  McpToolDefinition,
  McpToolHandler,
  TypedMcpToolHandler,
} from "@/api/mcp/tool-types";

type HandlerMap<TData> = {
  test_tool: TypedMcpToolHandler<TData>;
};

type UnvalidatedJson = ReturnType<typeof JSON.parse>;

describe("typed tool output contract", () => {
  test("accepts a declared record output", () => {
    expectTypeOf<
      AllHandlerOutputsTyped<HandlerMap<{ id: string }>, "test_tool">
    >().toEqualTypeOf<true>();
  });

  test("rejects broad and missing output types", () => {
    expectTypeOf<
      AllHandlerOutputsTyped<HandlerMap<UnvalidatedJson>, "test_tool">
    >().toEqualTypeOf<false>();
    expectTypeOf<
      AllHandlerOutputsTyped<HandlerMap<never>, "test_tool">
    >().toEqualTypeOf<false>();
    expectTypeOf<
      AllHandlerOutputsTyped<HandlerMap<unknown>, "test_tool">
    >().toEqualTypeOf<false>();
    expectTypeOf<
      AllHandlerOutputsTyped<HandlerMap<Record<string, unknown>>, "test_tool">
    >().toEqualTypeOf<false>();
    expectTypeOf<
      AllHandlerOutputsTyped<{ test_tool: McpToolHandler }, "test_tool">
    >().toEqualTypeOf<false>();
  });

  test("binds each handler output to its named projection contract", () => {
    expectTypeOf<
      HandlerOutputsMatchByName<
        HandlerMap<{ id: string }>,
        { test_tool: { id: string } },
        "test_tool"
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      HandlerOutputsMatchByName<
        HandlerMap<{ id: string }>,
        { test_tool: { name: string } },
        "test_tool"
      >
    >().toEqualTypeOf<false>();
  });
});

describe("MCP service classification contract", () => {
  test("rejects a tool without an explicit service classification", () => {
    expectTypeOf<
      Omit<McpToolDefinition, "consumesServices">
    >().not.toExtend<McpToolDefinition>();
    expectTypeOf<
      McpToolDefinition["consumesServices"]
    >().toEqualTypeOf<boolean>();
    expectTypeOf<
      ActionKindDefinition["consumesServices"]
    >().toEqualTypeOf<boolean>();
  });
});
