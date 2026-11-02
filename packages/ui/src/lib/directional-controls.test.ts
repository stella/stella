import { describe, expect, test } from "bun:test";

import { stripDirectionalControls } from "./directional-controls";

describe("stripDirectionalControls", () => {
  test("removes every embedding, override and isolate control", () => {
    const controls = [
      "\u202A",
      "\u202B",
      "\u202C",
      "\u202D",
      "\u202E",
      "\u2066",
      "\u2067",
      "\u2068",
      "\u2069",
    ];
    for (const control of controls) {
      expect(stripDirectionalControls(`a${control}b`)).toBe("ab");
    }
    expect(stripDirectionalControls("m \u202Efdp.exe\u202C")).toBe("m fdp.exe");
  });

  test("keeps implicit marks, joiners and right-to-left letters", () => {
    for (const text of [
      "\u200F\u05E9\u05DC\u05D5\u05DD (2)",
      "\u200Eabc",
      "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645",
      "P\u0159\u00EDloha \u010D. 1",
    ]) {
      expect(stripDirectionalControls(text)).toBe(text);
    }
  });
});
