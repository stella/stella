import { describe, expect, test } from "bun:test";

import {
  createErrorReference,
  formatErrorReference,
  isErrorReference,
} from "@/lib/analytics/error-reference";

describe("error support references", () => {
  test("formats only opaque random bytes", () => {
    expect(
      formatErrorReference(
        Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x12, 0x34]),
      ),
    ).toBe("ERR-DEAD-BEEF-1234");
  });

  test("rejects invalid reference shapes", () => {
    expect(isErrorReference("ERR-DEAD-BEEF-1234")).toBe(true);
    expect(isErrorReference("ERR-DEAD-BEEF")).toBe(false);
    expect(isErrorReference("/workspaces/private-matter")).toBe(false);
  });

  test("generates references in the public format", () => {
    expect(isErrorReference(createErrorReference())).toBe(true);
  });
});
