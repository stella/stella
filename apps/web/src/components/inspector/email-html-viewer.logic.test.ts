import { describe, expect, test } from "bun:test";

import {
  getEmailAttachmentSize,
  parseEmailDate,
} from "@/components/inspector/email-html-viewer.logic";

describe("email viewer metadata", () => {
  test("rejects missing and malformed dates without throwing", () => {
    expect(parseEmailDate(null)).toBeNull();
    expect(parseEmailDate("not a date")).toBeNull();
  });

  test("parses valid RFC email dates", () => {
    expect(parseEmailDate("Mon, 02 Jun 2026 10:00:00 +0000")).toEqual(
      new Date("2026-06-02T10:00:00.000Z"),
    );
  });

  test("selects a readable unit for attachment sizes", () => {
    expect(getEmailAttachmentSize(512)).toEqual({ unit: "byte", value: 512 });
    expect(getEmailAttachmentSize(2000)).toEqual({
      unit: "kilobyte",
      value: 2,
    });
    expect(getEmailAttachmentSize(2 * 1000 * 1000)).toEqual({
      unit: "megabyte",
      value: 2,
    });
    expect(getEmailAttachmentSize(2 * 1000 * 1000 * 1000)).toEqual({
      unit: "gigabyte",
      value: 2,
    });
    expect(getEmailAttachmentSize(1_000_000)).toEqual({
      unit: "megabyte",
      value: 1,
    });
  });
});
