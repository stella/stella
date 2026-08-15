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
});
