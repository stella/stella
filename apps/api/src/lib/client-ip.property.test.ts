import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { isIP } from "node:net";

import { assertProperty, propertyConfig } from "@stll/property-testing";

import {
  CLIENT_ADDRESS_SOURCE,
  FRONTEND_ADDRESS_HEADER,
  FRONTEND_VERIFY_HEADER,
  normalizeRateLimitClientAddress,
  ORIGIN_VERIFY_HEADER,
  parseTrustedProxies,
  resolveClientAddress,
} from "@/api/lib/client-ip";

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

describe("frontend edge address precedence", () => {
  const FRONTEND_HEADER = FRONTEND_ADDRESS_HEADER;
  const EDGE_HEADER = "cloudfront-viewer-address";
  const SECRETS = [
    "frontend-current-value-0123456789abcdef",
    "frontend-next-value-0123456789abcdef0123",
  ] as const;
  const ORIGIN = "origin-current-value-0123456789abcdef00";
  const options = {
    trusted: parseTrustedProxies("10.0.0.0/8"),
    edgeHeader: EDGE_HEADER,
    originSecrets: [ORIGIN],
    frontendSecrets: SECRETS,
  };
  // Header values are visible ASCII; Headers rejects control characters.
  const headerText = fc.stringMatching(/^[!-~]{0,72}$/u);
  const presentedValue = fc.oneof(
    fc.constantFrom(...SECRETS, ORIGIN),
    headerText,
    fc
      .tuple(fc.constantFrom(...SECRETS), headerText)
      .map(([secret, suffix]) => `${secret}${suffix}`),
    fc
      .tuple(fc.constantFrom(...SECRETS), fc.nat({ max: 39 }))
      .map(([secret, cut]) => secret.slice(0, cut)),
  );
  const addressValue = fc.oneof(
    fc.ipV4(),
    fc.ipV6(),
    fc.ipV4().map((address) => `${address}:443`),
    fc.ipV6().map((address) => `[${address}]:443`),
    headerText,
  );

  test("the frontend address is used only beside a configured frontend value", () => {
    assertProperty(
      "the frontend address is used only beside a configured frontend value",
      fc.property(
        fc.option(presentedValue, { nil: undefined }),
        addressValue,
        (presented, value) => {
          const request = new Request("https://example/test", {
            headers: {
              [EDGE_HEADER]: "192.0.2.10:443",
              [ORIGIN_VERIFY_HEADER]: ORIGIN,
              [FRONTEND_HEADER]: value,
              ...(presented === undefined
                ? {}
                : { [FRONTEND_VERIFY_HEADER]: presented }),
            },
          });
          const resolved = resolveClientAddress(
            request,
            { requestIP: () => ({ address: "10.0.0.5" }) },
            options,
          );
          const verified =
            presented !== undefined &&
            (SECRETS as readonly string[]).includes(presented);
          expect(resolved).toEqual(
            verified && isIP(value.trim()) !== 0
              ? {
                  address: value.trim(),
                  source: CLIENT_ADDRESS_SOURCE.frontendHeader,
                }
              : {
                  address: "192.0.2.10",
                  source: CLIENT_ADDRESS_SOURCE.edgeHeader,
                },
          );
        },
      ),
      propertyConfig({ numRuns: 400 }),
    );
  });
});
