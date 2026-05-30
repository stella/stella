// Regression eigenpal #424 gap 9 (w:vanish): the hidden mark's toDOM must
// NOT emit inline `text-decoration`. UnderlineExtension's parseDOM rule
// matches any element style containing "underline", so a dotted underline
// emitted here would round-trip through the clipboard / DOM reparse as both
// `hidden` and `underline` marks, adding a spurious `<w:u>` next to
// `<w:vanish/>` on DOCX export.

import { describe, expect, test } from "bun:test";

import { HiddenTextExtension } from "./HiddenTextExtension";

describe("HiddenTextExtension toDOM — eigenpal #424 gap 9", () => {
  test("emits only the docx-hidden class hook (no inline text-decoration)", () => {
    const extension = HiddenTextExtension();
    const spec = extension.config.markSpec;
    if (!spec.toDOM) {
      throw new Error("HiddenTextExtension must define toDOM");
    }

    // The mark argument is unused by this toDOM, but the PM type signature
    // requires one; passing a stub keeps the test independent of the
    // schema/mark plumbing.
    const fakeMark = { type: { name: "hidden" }, attrs: {} } as Parameters<
      typeof spec.toDOM
    >[0];
    const output = spec.toDOM(fakeMark, true);

    if (!Array.isArray(output)) {
      throw new TypeError("Expected DOMOutputSpec to be an array");
    }
    expect(output[0]).toBe("span");
    const attrs = output[1] as Record<string, string> | undefined;
    expect(attrs).toEqual({ class: "docx-hidden" });
    // Most important: no inline style with `text-decoration` so the
    // UnderlineExtension parser cannot pick it up on reparse.
    expect(attrs?.["style"]).toBeUndefined();
  });
});
