import { describe, expect, test } from "bun:test";

import { normalizeStringList } from "./string-list";

describe("lists of strings", () => {
  test("an array is taken as it is", () => {
    expect(normalizeStringList(["a", "b, c"], { split: "delimiters" })).toEqual(
      {
        ok: true,
        value: ["a", "b, c"],
      },
    );
  });

  test("an array's JSON sent as a string is read, whatever the split", () => {
    expect(normalizeStringList(' ["a, b", "c"] ', { split: "never" })).toEqual({
      ok: true,
      value: ["a, b", "c"],
      note: 'Read " [\\"a, b\\", \\"c\\"] " as ["a, b","c"].',
    });
  });

  test("ids joined by delimiters are split", () => {
    expect(
      normalizeStringList("a, b;c\nd,, ", { split: "delimiters" }),
    ).toEqual({
      ok: true,
      value: ["a", "b", "c", "d"],
      note: 'Read "a, b;c\\nd,, " as ["a","b","c","d"].',
    });
    expect(normalizeStringList("a", { split: "delimiters" })).toEqual({
      ok: true,
      value: ["a"],
      note: 'Read "a" as ["a"].',
    });
  });

  test("free text is wrapped as one item, never split on its commas", () => {
    expect(normalizeStringList("Smith, J.", { split: "never" })).toEqual({
      ok: true,
      value: ["Smith, J."],
      note: 'Read "Smith, J." as ["Smith, J."].',
    });
  });

  test("a bracketed string that is not a JSON array of strings is text", () => {
    expect(normalizeStringList("[draft]", { split: "never" })).toEqual(
      expect.objectContaining({ value: ["[draft]"] }),
    );
    expect(normalizeStringList("[1, 2]", { split: "never" })).toEqual(
      expect.objectContaining({ value: ["[1, 2]"] }),
    );
  });

  test.each([[42], [true], [null], [{ a: "b" }], [["a", 1]]])(
    "%p asks for a JSON array of strings",
    (input) => {
      expect(normalizeStringList(input, { split: "delimiters" })).toEqual(
        expect.objectContaining({
          ok: false,
          expected: "a list of strings",
          hint: 'Send a JSON array of strings, for example ["a", "b"]',
        }),
      );
    },
  );
});
