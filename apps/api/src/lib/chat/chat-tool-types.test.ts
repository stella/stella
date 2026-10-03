import { describe, expect, test } from "bun:test";

import type { ChatTool } from "@/api/lib/chat/chat-tool-types";
import {
  chatToolMapToArray,
  registeredChatTool,
} from "@/api/lib/chat/chat-tool-types";

const tool = (name: string): ChatTool => ({
  name,
  description: `Tool ${name}`,
});

describe("chat tool maps", () => {
  test("keeps registered TanStack tool names aligned with their map keys", () => {
    expect(
      chatToolMapToArray({
        lookup: tool("lookup"),
        skipped: undefined,
      }).map((item) => item.name),
    ).toEqual(["lookup"]);
  });

  test("fails fast when a map key and TanStack tool name diverge", () => {
    expect(() =>
      chatToolMapToArray({
        lookup: tool("search"),
      }),
    ).toThrow(
      'Chat tool map key "lookup" does not match TanStack tool name "search".',
    );
  });

  test("resolves only a tool registered under the name", () => {
    const lookup = tool("lookup");
    const tools = { lookup };

    expect(registeredChatTool(tools, "lookup")).toBe(lookup);
    for (const inherited of ["__proto__", "constructor", "toString"]) {
      expect(registeredChatTool(tools, inherited)).toBeUndefined();
    }
  });
});
