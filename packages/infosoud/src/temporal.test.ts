import { describe, expect, test } from "bun:test";

import { parseInfoSoudDateTime } from "./temporal.js";

describe("parseInfoSoudDateTime", () => {
  test("converts Czech summer wall times to the correct UTC instant", () => {
    expect(parseInfoSoudDateTime("15.04.2025 08:30")).toEqual({
      isoDateTime: "2025-04-15T08:30:00",
      raw: "15.04.2025 08:30",
      unixMs: Date.UTC(2025, 3, 15, 6, 30, 0),
    });
  });

  test("converts Czech winter wall times to the correct UTC instant", () => {
    expect(parseInfoSoudDateTime("15.01.2025 08:30")).toEqual({
      isoDateTime: "2025-01-15T08:30:00",
      raw: "15.01.2025 08:30",
      unixMs: Date.UTC(2025, 0, 15, 7, 30, 0),
    });
  });
});
