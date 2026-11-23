import { describe, expect, test } from "bun:test";

import { parseEmailDate } from "./email-reading.logic";

describe("an email's stated date", () => {
  test("an instant the reader states parses to that instant", () => {
    expect(parseEmailDate("2026-10-01T07:30:00.000Z")?.toISOString()).toBe(
      "2026-10-01T07:30:00.000Z",
    );
  });

  test("a header that is not a date is left to be shown as written", () => {
    expect(parseEmailDate("čtvrtek ráno")).toBeNull();
  });

  test("no date, or a blank one, is no date", () => {
    expect(parseEmailDate(null)).toBeNull();
    expect(parseEmailDate("  ")).toBeNull();
  });
});
