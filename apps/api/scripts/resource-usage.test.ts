import { describe, expect, test } from "bun:test";

import { maxRssBytesToMb } from "./resource-usage";

describe("maxRssBytesToMb", () => {
  test("treats Bun subprocess maxRSS as bytes on Linux too", () => {
    // The Bun 1.4 Linux CI reading that the old platform branch reported as
    // 403,796 MB was a normal 394 MB byte count.
    expect(maxRssBytesToMb(413_487_104)).toBe(394);
  });
});
