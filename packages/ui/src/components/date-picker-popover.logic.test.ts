import { describe, expect, test } from "bun:test";

import {
  localDateFromTimestamp,
  millisecondsUntilNextLocalDate,
} from "./date-picker-popover.logic";

describe("date picker clock", () => {
  test("derives the browser-local date on both sides of midnight", () => {
    expect(
      localDateFromTimestamp(new Date(2026, 7, 13, 23, 59, 59, 999).getTime()),
    ).toBe("2026-08-13");
    expect(localDateFromTimestamp(new Date(2026, 7, 14).getTime())).toBe(
      "2026-08-14",
    );
  });

  test("schedules refresh just after the next local date boundary", () => {
    expect(
      millisecondsUntilNextLocalDate(
        new Date(2026, 7, 13, 23, 59, 59, 900).getTime(),
      ),
    ).toBe(150);

    const midday = new Date(2026, 7, 13, 12).getTime();
    const nextMidnight = new Date(2026, 7, 14).getTime();
    expect(millisecondsUntilNextLocalDate(midday)).toBe(
      nextMidnight - midday + 50,
    );
  });
});
