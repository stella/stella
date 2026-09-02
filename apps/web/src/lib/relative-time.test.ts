import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";

import { getFormatter, useI18nStore } from "@/i18n/i18n-store";

import {
  formatContextualTimestamp,
  formatFullTimestamp,
  formatRelativeTime,
  getRelativeTimeFormatter,
  MEDIUM_DATE_SHORT_TIME_FORMAT,
} from "./relative-time";

const NOW = new Date("2026-01-15T12:00:00.000Z");
const initialI18nState = useI18nStore.getState();
const originalFormattingState = {
  loadedLang: initialI18nState.loadedLang,
  region: initialI18nState.region,
  regionalFormat: initialI18nState.regionalFormat,
  calendar: initialI18nState.calendar,
  numberingSystem: initialI18nState.numberingSystem,
  weekStart: initialI18nState.weekStart,
};

const secondsAgo = (seconds: number): Date =>
  new Date(NOW.getTime() - seconds * 1000);

beforeAll(() => {
  useI18nStore.setState({
    loadedLang: "en",
    region: "US",
    regionalFormat: "auto",
    calendar: "auto",
    numberingSystem: "auto",
    weekStart: "auto",
  });
  useI18nStore.getState().setRegionalFormat("auto");
});

beforeEach(() => {
  setSystemTime(NOW);
});

afterEach(() => {
  setSystemTime();
});

afterAll(() => {
  useI18nStore.setState(originalFormattingState);
  useI18nStore
    .getState()
    .setRegionalFormat(originalFormattingState.regionalFormat);
});

describe("relative time", () => {
  test.each([
    ["minute", 59, "this minute", 60, "1m ago"],
    ["hour", 3599, "59m ago", 3600, "1h ago"],
    ["day", 86_399, "23h ago", 86_400, "yesterday"],
    ["week", 604_799, "6d ago", 604_800, "last wk."],
    ["month", 2_591_999, "4w ago", 2_592_000, "last mo."],
    ["year", 31_535_999, "12mo ago", 31_536_000, "last yr."],
  ])(
    "switches to the %s unit at its threshold",
    (_unit, beforeSeconds, beforeExpected, atSeconds, atExpected) => {
      expect(formatRelativeTime(secondsAgo(beforeSeconds))).toBe(
        beforeExpected,
      );
      expect(formatRelativeTime(secondsAgo(atSeconds))).toBe(atExpected);
    },
  );

  test("formats future dates in the future direction", () => {
    const twoHoursFromNow = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);

    expect(formatRelativeTime(twoHoursFromNow)).toBe("in 2h");
  });

  test("accepts equivalent Date and ISO-string inputs", () => {
    const date = secondsAgo(2 * 60 * 60);

    expect(formatRelativeTime(date)).toBe("2h ago");
    expect(formatRelativeTime(date.toISOString())).toBe("2h ago");
  });

  test("returns an empty string for an invalid date", () => {
    expect(formatRelativeTime("not-a-date")).toBe("");
  });
});

describe("relative time formatter", () => {
  test("reuses a formatter for the same locale", () => {
    expect(getRelativeTimeFormatter("en-GB")).toBe(
      getRelativeTimeFormatter("en-GB"),
    );
  });

  test("keeps formatters separate across locales", () => {
    expect(getRelativeTimeFormatter("en-GB")).not.toBe(
      getRelativeTimeFormatter("fr-FR"),
    );
  });
});

describe("full timestamps", () => {
  test("formats Date and ISO-string inputs with the full date and time", () => {
    const date = new Date("2024-01-15T13:45:30.000Z");
    const expected = "Monday, January 15, 2024 at 1:45:30 PM";

    expect(formatFullTimestamp(date)).toBe(expected);
    expect(formatFullTimestamp(date.toISOString())).toBe(expected);
  });

  test("returns an empty string for an invalid date", () => {
    expect(formatFullTimestamp("not-a-date")).toBe("");
  });
});

describe("contextual timestamps", () => {
  test("uses the translated today label for a timestamp on the current day", () => {
    expect(
      formatContextualTimestamp({
        date: new Date("2026-01-15T13:45:00.000Z"),
        now: NOW,
        today: (time) => `Today, ${time}`,
      }),
    ).toBe("Today, 1:45 PM");
  });

  test("includes the date for a timestamp from another day", () => {
    const date = new Date("2026-01-14T13:45:00.000Z");
    let usedTodayLabel = false;

    expect(
      formatContextualTimestamp({
        date,
        now: NOW,
        today: () => {
          usedTodayLabel = true;
          return "Today";
        },
      }),
    ).toBe(getFormatter().dateTime(date, MEDIUM_DATE_SHORT_TIME_FORMAT));
    expect(usedTodayLabel).toBe(false);
  });

  test("returns an empty string for an invalid date", () => {
    expect(
      formatContextualTimestamp({
        date: "not-a-date",
        now: NOW,
        today: (time) => `Today, ${time}`,
      }),
    ).toBe("");
  });
});
