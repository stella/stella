import { describe, expect, test } from "bun:test";

import {
  hasOptionSeparator,
  splitOptionValues,
} from "@/components/workspaces/properties/inline-option-editor.logic";

describe("splitOptionValues", () => {
  test("a pasted comma or semicolon list becomes one option per entry", () => {
    expect(
      splitOptionValues({
        text: "dismissed, quashed and remanded; rejected as inadmissible",
        existing: [],
      }),
    ).toEqual([
      "dismissed",
      "quashed and remanded",
      "rejected as inadmissible",
    ]);
  });

  test("lines split too, blanks are dropped, and duplicates are kept once", () => {
    expect(
      splitOptionValues({
        text: "Czech\n\nEnglish\nCzech,  , German",
        existing: ["German"],
      }),
    ).toEqual(["Czech", "English"]);
  });

  test("a single value passes through untouched", () => {
    expect(splitOptionValues({ text: " lease ", existing: [] })).toEqual([
      "lease",
    ]);
    expect(hasOptionSeparator("lease")).toBe(false);
    expect(hasOptionSeparator("lease; loan")).toBe(true);
  });
});
