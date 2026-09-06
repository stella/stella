import { Panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { executedRows } from "@/api/lib/db/executed-rows";

/**
 * The failure this pins is the quiet one. Returning `[]` for a shape the
 * function does not recognise reads to every caller as "the query found
 * nothing", which for a guard is indistinguishable from "you may proceed". A
 * driver change would then turn every such guard off at once, with nothing
 * failing and nothing logged.
 */
describe("executedRows", () => {
  test("returns the rows the server driver yields directly", () => {
    const rows = [{ id: 1 }, { id: 2 }];

    expect(executedRows(rows)).toEqual(rows);
  });

  test("unwraps the { rows } shape pglite yields", () => {
    const rows = [{ id: 1 }];

    expect(executedRows({ rows, rowCount: 1 })).toEqual(rows);
  });

  test("an empty result is empty under either shape", () => {
    expect(executedRows([])).toEqual([]);
    expect(executedRows({ rows: [] })).toEqual([]);
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 7],
    ["a string", "rows"],
    ["an object with no rows key", { rowCount: 0 }],
    ["an object whose rows is not an array", { rows: { 0: { id: 1 } } }],
  ])("panics rather than reading %s as no rows", (_label, result) => {
    expect(() => executedRows(result)).toThrow(Panic);
  });
});
