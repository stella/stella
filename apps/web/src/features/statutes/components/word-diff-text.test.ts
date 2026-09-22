import { describe, expect, test } from "bun:test";

import { splitSurroundingWhitespace } from "@/features/statutes/components/word-diff-text";

describe("splitSurroundingWhitespace", () => {
  test("leaves the line break before an added heading title unmarked", () => {
    expect(splitSurroundingWhitespace("\nSmluvený rozvod manželství")).toEqual({
      leading: "\n",
      core: "Smluvený rozvod manželství",
      trailing: "",
    });
  });

  test("rebuilds the run exactly for any mix of whitespace and text", () => {
    for (const text of ["", " ", "\n\t ", " a ", "a", " (1) ", " a b "]) {
      const { core, leading, trailing } = splitSurroundingWhitespace(text);
      expect(leading + core + trailing).toBe(text);
      expect(core.trim()).toBe(core);
    }
  });

  test("a whitespace-only run has no visible part", () => {
    expect(splitSurroundingWhitespace(" \n ").core).toBe("");
  });
});
