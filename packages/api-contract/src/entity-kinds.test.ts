import { describe, expect, test } from "bun:test";

import { isEntityKind } from "./entity-kinds";

describe("isEntityKind", () => {
  test("accepts a canonical kind", () => {
    expect(isEntityKind("document")).toBe(true);
  });

  // The guard's whole job is to keep "not a kind" distinguishable from a
  // kind. A near miss that slipped through (or a default substituted for
  // one) reaches the UI as a confident wrong answer rather than an
  // unresolved one.
  // Each case is wrapped in a tuple: `test.each` spreads a bare array case
  // into the callback's arguments, which would quietly test "folder".
  test.each([
    ["Folder"],
    ["folders"],
    ["workspace"],
    [""],
    [" document"],
    [null],
    [undefined],
    [0],
    [["folder"]],
    [{ kind: "folder" }],
  ])("rejects %p", (value) => {
    expect(isEntityKind(value)).toBe(false);
  });
});
