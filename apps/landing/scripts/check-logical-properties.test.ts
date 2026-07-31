import { describe, expect, test } from "bun:test";

import { physicalPropertyFindings } from "./check-logical-properties";

// The guard exists so a physical utility cannot reach the RTL surfaces. Its
// one structural weakness is formatting: the same class list is legal on one
// line or spread over many, and only the multiline form used to slip through.
describe("physicalPropertyFindings", () => {
  test("reports a physical utility however the class attribute is wrapped", () => {
    const singleLine = '<div class="ml-2 flex" />';
    const wrappedList = [
      "<div class:list={[",
      '  "ml-2",',
      '  "flex",',
      "]} />",
    ].join("\n");
    const wrappedString = ['<div class="flex', '  ml-2" />'].join("\n");

    for (const source of [singleLine, wrappedList, wrappedString]) {
      expect(physicalPropertyFindings(source)).not.toEqual([]);
    }
  });

  test("ignores logical utilities and prose", () => {
    const source = [
      "<div class:list={[",
      '  "ms-2",',
      '  "text-start",',
      "]}>right-to-left reading order</div>",
    ].join("\n");

    expect(physicalPropertyFindings(source)).toEqual([]);
  });

  test("reports each offending line once", () => {
    const source = ["<div class:list={[", '  "ml-2",', "]} />"].join("\n");

    expect(physicalPropertyFindings(source)).toEqual([
      { line: 2, text: '"ml-2",' },
    ]);
  });
});
