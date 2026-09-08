import { describe, expect, test } from "bun:test";
import { Temporal as ForcedPolyfillTemporal } from "temporal-polyfill/full/implementation";

import { Temporal } from "./index";

const implementations = [
  { name: "native when available, otherwise polyfill", Temporal },
  { name: "forced polyfill", Temporal: ForcedPolyfillTemporal },
];

describe("Temporal runtime", () => {
  for (const { name, Temporal: implementation } of implementations) {
    test(`${name} preserves calendar and instant semantics`, () => {
      const dayBeforeDst = implementation.ZonedDateTime.from(
        "2024-03-09T12:00:00-05:00[America/New_York]",
      );

      expect(dayBeforeDst.add({ days: 1 }).toString()).toBe(
        "2024-03-10T12:00:00-04:00[America/New_York]",
      );
      expect(
        implementation.Instant.from("2024-01-01T00:00:00Z").toString({
          fractionalSecondDigits: 3,
        }),
      ).toBe("2024-01-01T00:00:00.000Z");
      expect(
        implementation.PlainDate.from("2024-02-29")
          .add({ years: 1 })
          .toString(),
      ).toBe("2025-02-28");

      const hebrewDate =
        implementation.PlainDate.from("2026-09-08").withCalendar("hebrew");
      expect(hebrewDate.calendarId).toBe("hebrew");
      expect(hebrewDate.withCalendar("iso8601").toString()).toBe("2026-09-08");
    });
  }

  test("selects native Temporal constructors when the runtime provides them", () => {
    if (globalThis.Temporal !== undefined) {
      expect(Temporal.Instant).toBe(globalThis.Temporal.Instant);
      expect(Temporal.ZonedDateTime).toBe(globalThis.Temporal.ZonedDateTime);
    }
  });
});
