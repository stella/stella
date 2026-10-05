import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";
import { Temporal } from "@stll/time";

import { APIError } from "@/lib/errors/api";

import {
  monthLockDate,
  resolveMonthLock,
  timePolicyErrorKey,
  timePolicyFormSchema,
  timePolicyPatch,
} from "./time-policy.logic";
import type { TimePolicy } from "./time-policy.logic";

const original = {
  timeMinimumUnitMinutes: 6,
  timeEditWindowDays: 30,
  timeLockedThroughMonth: "2024-01-31",
  timeNarrativeRequired: true,
} satisfies TimePolicy;
const changed = {
  timeMinimumUnitMinutes: 15,
  timeEditWindowDays: 0,
  timeLockedThroughMonth: null,
  timeNarrativeRequired: false,
} satisfies TimePolicy;
const TODAY = Temporal.PlainDate.from("2026-09-30");

describe("time policy changes", () => {
  test("sends only changed fields for every subset and preserves zero, false and null", () => {
    const entries = Object.entries(changed);
    for (let mask = 0; mask < 2 ** entries.length; mask++) {
      const expected = Object.fromEntries(
        entries.filter((_, index) => Math.floor(mask / 2 ** index) % 2 === 1),
      );
      const next = { ...original, ...expected };
      const patch = timePolicyPatch({ original, next });

      expect(patch).toEqual(expected);
      expect({ ...original, ...patch }).toEqual(next);
      expect({
        ...next,
        ...timePolicyPatch({ original: next, next: original }),
      }).toEqual(original);
      expect(timePolicyPatch({ original: next, next: { ...next } })).toEqual(
        {},
      );
    }
  });

  test("a full policy change round trips", () => {
    expect(timePolicyPatch({ original, next: changed })).toEqual(changed);
    expect(timePolicyPatch({ original: changed, next: original })).toEqual(
      original,
    );
    expect(timePolicyPatch({ original, next: { ...original } })).toEqual({});
  });
});

describe("closed month locks", () => {
  test("converts past months to their last calendar day", () => {
    for (const [month, date] of [
      ["2024-02", "2024-02-29"],
      ["2025-02", "2025-02-28"],
      ["2026-04", "2026-04-30"],
      ["2025-12", "2025-12-31"],
      ["2026-08", "2026-08-31"],
    ] as const) {
      const lock = resolveMonthLock(month, TODAY);
      expect(lock).toEqual({ type: "locked", date });
      expect(monthLockDate(lock)).toBe(date);
    }
  });

  test("clearing the month sends null", () => {
    const lock = resolveMonthLock("", TODAY);
    expect(lock).toEqual({ type: "clear" });
    expect(monthLockDate(lock)).toBeNull();
  });

  test("rejects malformed, current and future months", () => {
    for (const month of [
      "invalid",
      "2026-00",
      "2026-13",
      "2026-9",
      "2026-08-01",
      "0000-01",
      "2026-09",
      "2026-10",
      "2027-01",
    ]) {
      expect(resolveMonthLock(month, TODAY)).toEqual({ type: "invalid" });
    }
    expect(
      resolveMonthLock("2026-09", Temporal.PlainDate.from("2026-09-01")),
    ).toEqual({ type: "invalid" });
  });

  test("accepts a month only after its final day has passed", () => {
    expect(
      resolveMonthLock("2024-02", Temporal.PlainDate.from("2024-02-29")),
    ).toEqual({ type: "invalid" });
    expect(
      resolveMonthLock("2024-02", Temporal.PlainDate.from("2024-03-01")),
    ).toEqual({ type: "locked", date: "2024-02-29" });
  });

  test("refuses to convert invalid form state to a lock date", () => {
    expect(() => monthLockDate(resolveMonthLock("2026-10", TODAY))).toThrow(
      "Invalid month passed validated time policy form",
    );
  });
});

describe("time policy refusal messages", () => {
  test("selects actionable messages from typed API error codes", () => {
    expect(
      timePolicyErrorKey(
        new APIError({
          code: "invalid_time_minimum_unit",
          status: 400,
          message: "Refused",
        }),
      ),
    ).toBe("settings.organization.timePolicy.invalidMinimumUnit");
    expect(
      timePolicyErrorKey(
        new APIError({
          code: "invalid_time_locked_month",
          status: 400,
          message: "Refused",
        }),
      ),
    ).toBe("settings.organization.timePolicy.invalidLockedMonth");
  });

  test("leaves unrelated and untyped errors to normal handling", () => {
    expect(
      timePolicyErrorKey(
        new APIError({ code: "unknown", status: 400, message: "Failed" }),
      ),
    ).toBeNull();
    expect(
      timePolicyErrorKey(new APIError({ status: 500, message: "Failed" })),
    ).toBeNull();
    expect(
      timePolicyErrorKey({
        code: "invalid_time_locked_month",
        status: 400,
        message: "Refused",
      }),
    ).toBeNull();
    expect(timePolicyErrorKey(null)).toBeNull();
  });
});

describe("time policy form normalization", () => {
  const messages = {
    minimumUnit: "Invalid minimum unit",
    editWindow: "Invalid edit window",
    lockedMonth: "Invalid locked month",
  };
  const schema = timePolicyFormSchema({
    timeZone: "UTC",
    messages,
    at: TODAY.toZonedDateTime({ timeZone: "UTC" }).toInstant(),
  });
  const raw = {
    timeMinimumUnitMinutes: original.timeMinimumUnitMinutes,
    timeEditWindowDays: "0",
    timeLockedThroughMonth: "2024-02",
    timeNarrativeRequired: false,
  };

  test("parses raw fields into a normalized patch and omits unchanged values", () => {
    const next = v.parse(schema, raw);
    expect(next).toEqual({
      timeMinimumUnitMinutes: 6,
      timeEditWindowDays: 0,
      timeLockedThroughMonth: "2024-02-29",
      timeNarrativeRequired: false,
    });
    expect(timePolicyPatch({ original, next })).toEqual({
      timeEditWindowDays: 0,
      timeLockedThroughMonth: "2024-02-29",
      timeNarrativeRequired: false,
    });
  });

  test("normalizes a cleared month to null without dropping false or zero", () => {
    const next = v.parse(schema, { ...raw, timeLockedThroughMonth: "" });
    expect(next.timeLockedThroughMonth).toBeNull();
    expect(timePolicyPatch({ original, next })).toEqual({
      timeEditWindowDays: 0,
      timeLockedThroughMonth: null,
      timeNarrativeRequired: false,
    });
  });

  test("rejects minimum units that do not divide an hour", () => {
    for (const unit of [7, 11, 13, 59]) {
      expect(() =>
        v.parse(schema, { ...raw, timeMinimumUnitMinutes: unit }),
      ).toThrow(messages.minimumUnit);
    }
  });

  test("rejects fractional and unsafe edit windows before normalization", () => {
    for (const days of [
      "1.5",
      "0.1",
      "9007199254740992",
      "999999999999999999999999",
    ]) {
      expect(() =>
        v.parse(schema, { ...raw, timeEditWindowDays: days }),
      ).toThrow(messages.editWindow);
    }
  });
});

// Every zone this runtime knows; the property picks a wall-clock moment in the
// first two hours of a month there, so the expected organization day is the
// chosen date by construction rather than by recomputing it.
const RUNTIME_ZONES = Intl.supportedValuesOf("timeZone");
const FIRST_YEAR = 1995;
const LAST_YEAR = 2039;
const MONTHS_IN_YEAR = 12;
const LAST_EARLY_MINUTE = 119;

describe("time policy form (properties)", () => {
  test(
    "offers a lock month once the organization's day has left it",
    () => {
      assertProperty(
        "offers a lock month once the organization's day has left it",
        fc.property(
          fc.constantFrom(...RUNTIME_ZONES),
          fc.integer({ min: FIRST_YEAR, max: LAST_YEAR }),
          fc.integer({ min: 1, max: MONTHS_IN_YEAR }),
          fc.integer({ min: 0, max: LAST_EARLY_MINUTE }),
          fc.boolean(),
          (zone, year, month, minuteOfDay, previous) => {
            const today = Temporal.PlainDate.from({ year, month, day: 1 });
            const wallClock = Temporal.PlainTime.from({
              hour: Math.floor(minuteOfDay / 60),
              minute: minuteOfDay % 60,
            });
            const local = Result.try(() =>
              today
                .toPlainDateTime(wallClock)
                .toZonedDateTime(zone, { disambiguation: "reject" }),
            );
            // A wall time a DST gap skips names no instant.
            fc.pre(Result.isOk(local));
            if (Result.isError(local)) {
              return;
            }
            const lockMonth = previous ? today.subtract({ months: 1 }) : today;
            const lastDay = lockMonth.with({ day: lockMonth.daysInMonth });
            const parsed = v.safeParse(
              timePolicyFormSchema({
                timeZone: zone,
                at: local.value.toInstant(),
                messages: {
                  minimumUnit: "unit",
                  editWindow: "window",
                  lockedMonth: "month",
                },
              }),
              {
                timeMinimumUnitMinutes: 6,
                timeEditWindowDays: "0",
                timeLockedThroughMonth: lockMonth.toString().slice(0, 7),
                timeNarrativeRequired: false,
              },
            );
            expect(parsed.success).toBe(
              Temporal.PlainDate.compare(lastDay, today) < 0,
            );
          },
        ),
      );
    },
    propertyTestTimeout(20_000),
  );
});
