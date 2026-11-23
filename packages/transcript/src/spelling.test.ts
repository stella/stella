import { describe, expect, test } from "bun:test";

import { respell } from "./spelling";
import cases from "./spelling.fixtures.json";

// The desktop's local spelling pass (dictation_spelling.rs) reads the same
// cases, so both spell the same words the same way.
describe("respell", () => {
  test("the shared cases are there", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const { name, text, words, expected } of cases) {
    test(name, () => {
      expect(respell(text, words)).toBe(expected);
    });
  }
});
