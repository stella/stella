import { describe, expect, test } from "bun:test";

import { hexOf } from "./hex";

describe("a file's digest as hex", () => {
  test("is lowercase, two digits a byte, leading zeros kept", () => {
    expect(hexOf(new Uint8Array([0, 1, 15, 16, 171, 255]))).toBe(
      "00010f10abff",
    );
  });
});
