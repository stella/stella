import { describe, expect, test } from "bun:test";

import { diffWords } from "@/components/ai-suggestions/review-word-diff";

describe("word diff", () => {
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
