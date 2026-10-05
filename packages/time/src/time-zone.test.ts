import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { parseTimeZoneId } from "./time-zone";

const RUNTIME_ZONES = Intl.supportedValuesOf("timeZone");

describe("parseTimeZoneId", () => {
  test("reads every zone the runtime lists, case and whitespace aside", () => {
    assertProperty(
      "reads every zone the runtime lists, case and whitespace aside",
      fc.property(
        fc.constantFrom(...RUNTIME_ZONES),
        fc.constantFrom("", " ", "\t"),
        fc.boolean(),
        (zone, padding, lowerCase) => {
          const spelled = lowerCase ? zone.toLowerCase() : zone;
          const parsed = parseTimeZoneId(`${padding}${spelled}${padding}`);
          expect(parsed).not.toBeNull();
          // A parsed id is a fixed point: reading it again changes nothing.
          expect(parseTimeZoneId(parsed ?? "")).toBe(parsed);
        },
      ),
    );
  });

  test("keeps the canonical spelling of a listed zone", () => {
    const read = (value: string): string | null => parseTimeZoneId(value);
    expect(read("Europe/Prague")).toBe("Europe/Prague");
    expect(read("europe/prague")).toBe("Europe/Prague");
    expect(read("UTC")).toBe("UTC");
  });

  test("refuses fixed offsets, unknown names and blanks", () => {
    for (const value of ["+01:00", "-05:00", "Mars/Olympus_Mons", "", "  "]) {
      expect(parseTimeZoneId(value)).toBeNull();
    }
  });
});
