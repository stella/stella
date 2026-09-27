import { describe, expect, test } from "bun:test";

import { normalizeDateBound, normalizeDateValue } from "./date-value";
import type { DateBound } from "./date-value";
import type { NormalizedOptional } from "./normalized";

const outcome = (result: NormalizedOptional<string>): string => {
  if (result.ok === "absent") {
    return "absent";
  }
  return result.ok ? result.value : `ask: ${result.hint}`;
};

const bound = (input: string, side: DateBound): string =>
  outcome(normalizeDateBound(input, { bound: side }));

describe("date range bounds", () => {
  test.each([
    ["2020", "2020-01-01", "2020-12-31"],
    ["2020-02", "2020-02-01", "2020-02-29"],
    ["2021-02", "2021-02-01", "2021-02-28"],
    ["2/2024", "2024-02-01", "2024-02-29"],
    ["04/2023", "2023-04-01", "2023-04-30"],
    ["1. 2. 2020", "2020-02-01", "2020-02-01"],
    ["1000-01-01", "1000-01-01", "1000-01-01"],
  ])("reads %s as %s from and %s to", (input, start, end) => {
    expect(bound(input, "start")).toBe(start);
    expect(bound(input, "end")).toBe(end);
  });

  test("a partial date is reported as read", () => {
    expect(normalizeDateBound("2020", { bound: "end" })).toEqual({
      ok: true,
      value: "2020-12-31",
      note: 'Read "2020" as "2020-12-31".',
    });
  });

  test("a partial date is never read without a bound", () => {
    expect(normalizeDateValue("2020").ok).toBe(false);
    expect(normalizeDateValue("2020-02").ok).toBe(false);
    expect(normalizeDateValue("2/2024").ok).toBe(false);
  });

  test.each([["0001-01-01"], ["9999-12-31"], ["31. 12. 9999"], ["9999"]])(
    "the open-ended sentinel %s is no bound",
    (input) => {
      expect(normalizeDateBound(input, { bound: "end" })).toEqual({
        ok: "absent",
        received: JSON.stringify(input),
        note: `Read ${JSON.stringify(input)} as no value: an open bound.`,
      });
    },
  );

  test("a placeholder is no bound", () => {
    expect(bound("any", "start")).toBe("absent");
    expect(bound("", "end")).toBe("absent");
  });

  test.each([
    ["2020-01-01..2020-12-31", "2020-01-01", "2020-12-31"],
    ["2020-01-01/2020-12-31", "2020-01-01", "2020-12-31"],
    ["2020-01-01 - 2020-12-31", "2020-01-01", "2020-12-31"],
    ["2020-01-01 – 2020-12-31", "2020-01-01", "2020-12-31"],
    ["2020-01-01 to 2020-12-31", "2020-01-01", "2020-12-31"],
    ["2020..2021", "2020-01-01", "2021-12-31"],
    ["2020-2021", "2020-01-01", "2021-12-31"],
  ])("a range %s in one bound asks for its two halves", (input, from, to) => {
    for (const side of ["start", "end"] as const) {
      const result = normalizeDateBound(input, { bound: side });
      expect(result.ok === false && result.expected).toBe("a single date");
      expect(outcome(result)).toBe(
        "ask: This is one bound of a range: send the start and the end as " +
          "two separate date properties (for example date_from " +
          `"${from}" and date_to "${to}").`,
      );
    }
  });

  test("a single date whose parts are joined by slashes is not a range", () => {
    expect(bound("2020/10/01", "start")).toBe("2020-10-01");
    expect(bound("13/10/2026", "end")).toBe("2026-10-13");
  });
});
