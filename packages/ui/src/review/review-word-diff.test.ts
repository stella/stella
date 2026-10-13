import { describe, expect, test } from "bun:test";

import { diffWords } from "./review-word-diff";

describe("word diff", () => {
  test("large token streams preserve both wordings as a bounded replacement", () => {
    for (const count of [260, 3000]) {
      const before = "a ".repeat(count);
      const after = "b ".repeat(count);
      const ops = diffWords(before, after);
      expect(ops.some(({ type }) => type === "equal")).toBe(false);
      expect(
        ops
          .filter(({ type }) => type !== "insert")
          .map(({ token }) => token)
          .join(""),
      ).toBe(before);
      expect(
        ops
          .filter(({ type }) => type !== "delete")
          .map(({ token }) => token)
          .join(""),
      ).toBe(after);
      expect(
        diffWords(before, before).every(({ type }) => type === "equal"),
      ).toBe(true);
    }
  });
  test("identical text is entirely equal", () => {
    expect(diffWords("twelve months", "twelve months")).toEqual([
      { token: "twelve", type: "equal" },
      { token: " ", type: "equal" },
      { token: "months", type: "equal" },
    ]);
  });

  test("a replaced word is a delete followed by an insert", () => {
    expect(diffWords("within twelve months", "within six months")).toEqual([
      { token: "within", type: "equal" },
      { token: " ", type: "equal" },
      { token: "twelve", type: "delete" },
      { token: "six", type: "insert" },
      { token: " ", type: "equal" },
      { token: "months", type: "equal" },
    ]);
  });

  test("an added clause is a pure insert", () => {
    expect(
      diffWords("notice in writing", "notice in writing and by email"),
    ).toEqual([
      { token: "notice", type: "equal" },
      { token: " ", type: "equal" },
      { token: "in", type: "equal" },
      { token: " ", type: "equal" },
      { token: "writing", type: "equal" },
      { token: " ", type: "insert" },
      { token: "and", type: "insert" },
      { token: " ", type: "insert" },
      { token: "by", type: "insert" },
      { token: " ", type: "insert" },
      { token: "email", type: "insert" },
    ]);
  });

  test("a removed clause is a pure delete", () => {
    expect(diffWords("subject to Applicable Law", "subject to")).toEqual([
      { token: "subject", type: "equal" },
      { token: " ", type: "equal" },
      { token: "to", type: "equal" },
      { token: " ", type: "delete" },
      { token: "Applicable", type: "delete" },
      { token: " ", type: "delete" },
      { token: "Law", type: "delete" },
    ]);
  });

  test("both sides empty is a no-op", () => {
    expect(diffWords("", "")).toEqual([]);
  });

  test("one side empty is a pure insert or delete", () => {
    expect(diffWords("", "new clause")).toEqual([
      { token: "new", type: "insert" },
      { token: " ", type: "insert" },
      { token: "clause", type: "insert" },
    ]);
    expect(diffWords("old clause", "")).toEqual([
      { token: "old", type: "delete" },
      { token: " ", type: "delete" },
      { token: "clause", type: "delete" },
    ]);
  });
});
