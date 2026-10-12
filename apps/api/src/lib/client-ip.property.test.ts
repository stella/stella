import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { normalizeRateLimitClientAddress } from "@/api/lib/client-ip";

const cases = [
  ["", ""],
  ["not-an-ip", "not-an-ip"],
  ["192.0.2.1", "192.0.2.1"],
  ["192.0.2.001", "192.0.2.001"],
  ["256.0.0.1", "256.0.0.1"],
  ["::", "::"],
  ["::1", "::"],
  ["::ffff:192.0.2.1", "192.0.2.1"],
  ["::FFFF:c000:201", "192.0.2.1"],
  ["2001:0DB8:abcd:1234::9", "2001:db8:abcd:1234::"],
  ["2001:DB8:0:1:0:0:0:1", "2001:db8:0:1::"],
  ["1:2:3:4:5:6:7:8", "1:2:3:4::"],
  ["1:2:0:0::1", "1:2::"],
  ["64:ff9b::192.0.2.1", "64:ff9b::"],
  ["fe80::1%eth0", "fe80::"],
  ["2001:db8::1/64", "2001:db8::1/64"],
  ["[::1]", "[::1]"],
] as const;

describe("client IP normalization", () => {
  test.each(cases)("normalizes %p to %p", (address, expected) => {
    expect(normalizeRateLimitClientAddress(address)).toBe(expected);
  });

  test("normalizes equivalent address spellings to one key", () => {
    fc.assert(
      fc.property(fc.oneof(fc.ipV4(), fc.ipV6(), fc.string()), (address) => {
        const normalized = normalizeRateLimitClientAddress(address);
        expect(normalizeRateLimitClientAddress(normalized)).toBe(normalized);
      }),
      propertyConfig({ numRuns: 600 }),
    );
  });
});
