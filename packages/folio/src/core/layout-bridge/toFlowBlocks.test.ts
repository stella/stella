import { describe, expect, test } from "bun:test";

import { schema } from "../prosemirror/schema";
import { toFlowBlocks } from "./toFlowBlocks";

describe("toFlowBlocks paragraph formatting", () => {
  test("does not convert absent paragraph spacing defaults to zero line height", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("First paragraph")]),
    ]);

    const blocks = toFlowBlocks(doc);
    const paragraph = blocks.at(0);

    expect(paragraph?.kind).toBe("paragraph");
    expect(paragraph?.attrs?.spacing).toBeUndefined();
    expect(paragraph?.attrs?.indent).toBeUndefined();
  });

  test("preserves explicit automatic line spacing", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", { lineSpacing: 240, lineSpacingRule: "auto" }, [
        schema.text("First paragraph"),
      ]),
    ]);

    const blocks = toFlowBlocks(doc);
    const paragraph = blocks.at(0);

    expect(paragraph?.kind).toBe("paragraph");
    expect(paragraph?.attrs?.spacing).toEqual({
      line: 1,
      lineRule: "auto",
      lineUnit: "multiplier",
    });
  });
});
