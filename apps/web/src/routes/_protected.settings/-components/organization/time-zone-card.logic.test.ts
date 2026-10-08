import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { parseTimeZoneId } from "@stll/time";

import { COMMON_TIMEZONES } from "@/lib/timezones";

import {
  FOLLOW_JURISDICTION,
  timeZonePickerValue,
  timeZoneToSave,
} from "./time-zone-card.logic";

const ZONES = COMMON_TIMEZONES.map(
  (zone) => parseTimeZoneId(zone) ?? panic(`Unknown zone ${zone}`),
);

describe("time-zone picker", () => {
  test("a derived zone selects the follow entry, so picking the zone pins it", () => {
    for (const timeZone of ZONES) {
      const selected = timeZonePickerValue({
        timeZone,
        timeZoneSource: "practice-jurisdiction",
      });
      expect(selected).toBe(FOLLOW_JURISDICTION);
      expect(String(timeZone)).not.toBe(selected);
      expect(timeZoneToSave(timeZone)).toBe(timeZone);
    }
  });

  test("a stored zone selects itself and the follow entry clears it", () => {
    for (const timeZone of ZONES) {
      const selected = timeZonePickerValue({
        timeZone,
        timeZoneSource: "organization",
      });
      expect(selected).toBe(timeZone);
      expect(timeZoneToSave(FOLLOW_JURISDICTION)).toBeNull();
    }
  });
});
