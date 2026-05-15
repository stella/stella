import { describe, expect, test } from "bun:test";

import { schema } from "../../schema";

const paragraphDomAttrs = (
  attrs: Record<string, unknown>,
): Record<string, string> => {
  const paragraph = schema.node("paragraph", attrs);
  const toDOM = paragraph.type.spec.toDOM;
  if (!toDOM) {
    throw new Error("Expected paragraph node to provide toDOM");
  }

  const domSpec = toDOM(paragraph) as [string, Record<string, string>, number];

  return domSpec[1];
};

describe("ParagraphExtension", () => {
  test("preserves explicit list paragraph left indent", () => {
    const attrs = paragraphDomAttrs({
      indentLeft: 1440,
      numPr: { ilvl: 0, numId: 1 },
    });

    expect(attrs["style"]).toContain("margin-left: 96px");
    expect(attrs["style"]).not.toContain("margin-left: 48px");
  });

  test("uses the synthetic list indent when left indent is null", () => {
    const attrs = paragraphDomAttrs({
      indentLeft: null,
      numPr: { ilvl: 1, numId: 1 },
    });

    expect(attrs["style"]).toContain("margin-left: 96px");
  });
});
