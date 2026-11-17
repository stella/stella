import { expect, test } from "bun:test";
import * as v from "valibot";

import { displayNameSchema } from "@stll/api-contract/display-name";
import { stripDirectionalControls } from "@stll/ui/bidi-text";

/**
 * `@stll/ui` builds standalone, so it cannot import the API contract's set
 * of directional controls. Every code point must be treated the same by
 * both, or a stored name could still reorder on screen.
 */
test("stored and rendered names drop exactly the same characters", () => {
  const stored = displayNameSchema({ allowEmpty: true });
  const differing: string[] = [];
  for (let codePoint = 0; codePoint <= 0x10_ff_ff; codePoint += 1) {
    if (codePoint >= 0xd8_00 && codePoint <= 0xdf_ff) {
      continue;
    }
    const text = `a${String.fromCodePoint(codePoint)}b`;
    if (v.parse(stored, text) !== stripDirectionalControls(text)) {
      differing.push(codePoint.toString(16));
    }
  }
  expect(differing).toEqual([]);
  expect(v.parse(stored, "a\u202Eb\u2069c\u200F")).toBe("abc\u200F");
});
