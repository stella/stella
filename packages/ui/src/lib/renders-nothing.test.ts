import { describe, expect, test } from "bun:test";

import { rendersNothing } from "./renders-nothing";

describe("rendersNothing", () => {
  test("nodes React draws nothing for", () => {
    for (const node of [
      null,
      undefined,
      false,
      true,
      "",
      [],
      [null, false, ""],
      [[]],
    ]) {
      expect(rendersNothing(node)).toBe(true);
    }
  });

  test("nodes that draw something", () => {
    for (const node of [0, " ", "Save", ["", "x"], [[0]]]) {
      expect(rendersNothing(node)).toBe(false);
    }
  });
});
