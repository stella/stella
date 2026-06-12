import { describe, expect, test } from "bun:test";

import type { ChatTool } from "@/api/handlers/chat/tools/chat-tool-types";
import { chatToolMapToArray } from "@/api/handlers/chat/tools/chat-tool-types";

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
});
