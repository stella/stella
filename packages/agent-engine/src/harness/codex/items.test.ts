import { describe, expect, test } from "bun:test";

import { codexItemHandling } from "./items";
import { CODEX_ITEM_TYPES, CodexItemSchema } from "./protocol";

describe("Codex item handling", () => {
  test("the kinds stella shows are exactly the kinds it parses", () => {
    const shown = CODEX_ITEM_TYPES.filter(
      (type) => codexItemHandling(type) !== "ignore",
    );
    const parsed = CodexItemSchema.options.map(
      (option) => option.entries.type.literal,
    );
    expect(new Set(shown)).toEqual(new Set(parsed));
  });
});
