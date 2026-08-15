import { describe, expect, test } from "bun:test";

import { getFileSizeDisplay } from "@/lib/file-size";

describe("file size display", () => {
  test("selects a readable decimal unit", () => {
    expect(getFileSizeDisplay(512)).toEqual({ unit: "byte", value: 512 });
    expect(getFileSizeDisplay(2000)).toEqual({
      unit: "kilobyte",
      value: 2,
    });
    expect(getFileSizeDisplay(2 * 1000 * 1000)).toEqual({
      unit: "megabyte",
      value: 2,
    });
    expect(getFileSizeDisplay(2 * 1000 * 1000 * 1000)).toEqual({
      unit: "gigabyte",
      value: 2,
    });
    expect(getFileSizeDisplay(1_000_000)).toEqual({
      unit: "megabyte",
      value: 1,
    });
  });

  test("changes units exactly at each decimal threshold", () => {
    const cases = [
      { sizeBytes: 999, unit: "byte", value: 999 },
      { sizeBytes: 1000, unit: "kilobyte", value: 1 },
      { sizeBytes: 1001, unit: "kilobyte", value: 1.001 },
      { sizeBytes: 999_999, unit: "kilobyte", value: 999.999 },
      { sizeBytes: 1_000_000, unit: "megabyte", value: 1 },
      { sizeBytes: 1_000_001, unit: "megabyte", value: 1.000_001 },
      { sizeBytes: 999_999_999, unit: "megabyte", value: 999.999_999 },
      { sizeBytes: 1_000_000_000, unit: "gigabyte", value: 1 },
      { sizeBytes: 1_000_000_001, unit: "gigabyte", value: 1.000_000_001 },
    ] as const;

    for (const { sizeBytes, unit, value } of cases) {
      expect(getFileSizeDisplay(sizeBytes)).toEqual({ unit, value });
    }
  });
});
