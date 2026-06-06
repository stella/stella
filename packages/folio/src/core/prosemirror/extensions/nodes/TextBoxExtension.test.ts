import { describe, expect, test } from "bun:test";

import { schema } from "../../schema";

describe("TextBoxExtension toDOM border", () => {
  const styleOf = (attrs: Record<string, unknown>): string => {
    const node = schema.node("textBox", attrs, [
      schema.node("paragraph", null, [schema.text("x")]),
    ]);
    const toDOM = node.type.spec.toDOM;
    if (!toDOM) {
      throw new Error("Expected textBox node to provide toDOM");
    }
    const domSpec = toDOM(node) as [string, Record<string, string>, number];
    return domSpec[1]["style"] ?? "";
  };

  test("draws no border for the explicit 'none' outline sentinel", () => {
    // `box-sizing: border-box` is always present, so assert on the border
    // shorthand specifically.
    expect(styleOf({ outlineStyle: "none" })).not.toContain("border:");
  });

  test("draws the default editor border when no outline is set", () => {
    expect(styleOf({})).toContain("border: 1px solid");
  });
});
