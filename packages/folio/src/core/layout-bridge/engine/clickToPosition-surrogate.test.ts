/**
 * A click landing in the second half of an astral CJK glyph must not resolve to
 * the offset between its surrogate pair, or ProseMirror could place/edit a
 * selection inside the pair.
 */

import { describe, expect, test } from "bun:test";

import { snapPastTrailingSurrogate } from "./clickToPosition";

describe("snapPastTrailingSurrogate", () => {
  const text = "A𠀀B"; // A, astral ideograph (surrogates at 1,2), B

  test("nudges a mid-pair offset forward to the code-point boundary", () => {
    // Offset 2 is the trailing surrogate of 𠀀 — snap to 3 (after the glyph).
    expect(snapPastTrailingSurrogate(text, 2)).toBe(3);
  });

  test("leaves valid code-point boundaries unchanged", () => {
    expect(snapPastTrailingSurrogate(text, 0)).toBe(0); // before A
    expect(snapPastTrailingSurrogate(text, 1)).toBe(1); // before 𠀀 (high surrogate)
    expect(snapPastTrailingSurrogate(text, 3)).toBe(3); // after 𠀀, before B
    expect(snapPastTrailingSurrogate(text, 4)).toBe(4); // end
  });

  test("leaves all-BMP text untouched", () => {
    expect(snapPastTrailingSurrogate("hello", 3)).toBe(3);
  });
});
