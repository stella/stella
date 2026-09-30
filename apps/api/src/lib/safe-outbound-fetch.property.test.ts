import { Result } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import {
  parseSafeOutboundUrl,
  SafeOutboundFetchError,
  validateOutboundFetchTarget,
} from "@/api/lib/safe-outbound-fetch";

const octet = fc.integer({ min: 0, max: 255 });
const restrictedAddress = fc.oneof(
  fc.tuple(fc.constantFrom(0, 10, 127), octet, octet, octet),
  fc.tuple(fc.constant(169), fc.constant(254), octet, octet),
  fc.tuple(fc.constant(172), fc.integer({ min: 16, max: 31 }), octet, octet),
  fc.tuple(fc.constant(192), fc.constant(168), octet, octet),
  fc.tuple(fc.constant(100), fc.integer({ min: 64, max: 127 }), octet, octet),
  fc.tuple(fc.constant(192), fc.constant(0), fc.constantFrom(0, 2), octet),
  fc.tuple(fc.constant(198), fc.constantFrom(18, 19), octet, octet),
  fc.tuple(fc.constant(198), fc.constant(51), fc.constant(100), octet),
  fc.tuple(fc.constant(203), fc.constant(0), fc.constant(113), octet),
  fc.tuple(fc.integer({ min: 224, max: 255 }), octet, octet, octet),
);
const publicAddress = fc.tuple(
  fc.constantFrom(8, 9, 11, 20, 80, 93),
  octet,
  octet,
  octet,
);

type Address = readonly [number, number, number, number];

const embeddedHosts = ([a, b, c, d]: Address): string[] => {
  const high = (a * 256 + b).toString(16);
  const low = (c * 256 + d).toString(16);
  const invertedHigh = ((255 - a) * 256 + (255 - b)).toString(16);
  const invertedLow = ((255 - c) * 256 + (255 - d)).toString(16);
  return [
    `::${a}.${b}.${c}.${d}`,
    `::ffff:${a}.${b}.${c}.${d}`,
    `64:ff9b::${high}:${low}`,
    `64:ff9b:1:${high}:${c.toString(16)}:${(d * 256).toString(16)}:0:0`,
    `64:ff9b:1::${high}:${low}`,
    `2002:${high}:${low}::1`,
    `2001:0:808:808:0:0:${invertedHigh}:${invertedLow}`,
  ];
};

const spellings = (host: string): string[] => {
  const canonical = new URL(`https://[${host}]/`).hostname.slice(1, -1);
  const [left = "", right] = canonical.split("::");
  const leading = left === "" ? [] : left.split(":");
  const trailing = right === undefined || right === "" ? [] : right.split(":");
  const full = [
    ...leading,
    ...Array.from({ length: 8 - leading.length - trailing.length }, () => "0"),
    ...trailing,
  ]
    .map((part) => part.padStart(4, "0"))
    .join(":");
  return [host, canonical, full, full.toUpperCase()];
};

test(
  "outbound input handling follows the address policy",
  () => {
    fc.assert(
      fc.property(restrictedAddress, ([a, b, c, d]) => {
        const dotted = `${a}.${b}.${c}.${d}`;
        const numeric = a * 2 ** 24 + b * 2 ** 16 + c * 256 + d;
        const hosts = [
          dotted,
          `${dotted}.`,
          String(numeric),
          `0x${numeric.toString(16)}`,
          `0${numeric.toString(8)}`,
          `${a}.${b}.${c * 256 + d}`,
          `${a}.${b * 2 ** 16 + c * 256 + d}`,
          [a, b, c, d].map((value) => `0${value.toString(8)}`).join("."),
          dotted.replaceAll(".", "%2e"),
          dotted.replaceAll(".", "。"),
          ...embeddedHosts([a, b, c, d]).flatMap((host) =>
            spellings(host).map((spelling) => `[${spelling}]`),
          ),
        ];
        for (const host of hosts) {
          const result = parseSafeOutboundUrl(`https://${host}/`);
          expect(Result.isError(result)).toBe(true);
          if (Result.isError(result)) {
            expect(SafeOutboundFetchError.is(result.error)).toBe(true);
          }
        }
      }),
      propertyConfig({ seed: propertySeed(), examples: [[[0, 0, 0, 2]]] }),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "outbound input handling preserves public mapped addresses",
  () => {
    fc.assert(
      fc.property(publicAddress, ([a, b, c, d]) => {
        for (const host of spellings(`::ffff:${a}.${b}.${c}.${d}`)) {
          expect(Result.isOk(parseSafeOutboundUrl(`https://[${host}]/`))).toBe(
            true,
          );
        }
      }),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "outbound input handling follows local prefix policy",
  () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 0xff_ff }), {
          minLength: 8,
          maxLength: 8,
        }),
        (parts) => {
          const suffix = parts
            .slice(3)
            .map((part) => part.toString(16))
            .join(":");
          const hosts = [
            `64:ff9b:1:${suffix}`,
            `::${parts.at(6)?.toString(16)}:${parts.at(7)?.toString(16)}`,
            ...["fe80", "febf", "fc00", "fdff", "ff00", "ffff", "0100"].map(
              (prefix) =>
                `${prefix}:${parts
                  .slice(1)
                  .map((part) => part.toString(16))
                  .join(":")}`,
            ),
            `2001:db8:${parts
              .slice(2)
              .map((part) => part.toString(16))
              .join(":")}`,
            `2001:2:${parts
              .slice(2)
              .map((part) => part.toString(16))
              .join(":")}`,
          ];
          for (const host of hosts) {
            for (const spelling of spellings(host)) {
              expect(
                Result.isError(parseSafeOutboundUrl(`https://[${spelling}]/`)),
              ).toBe(true);
            }
          }
        },
      ),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "outbound input handling rejects credential and local host shapes",
  () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "localhost",
          "localhost.",
          "ip6-localhost",
          "host.local",
          "host.internal",
          "xn--host-9za.local",
        ),
        fc.constantFrom("", "user@", "a@b@", "user%40name@"),
        (host, userinfo) => {
          for (const separator of ["/", "\\"]) {
            expect(
              Result.isError(
                parseSafeOutboundUrl(`https://${userinfo}${host}${separator}`),
              ),
            ).toBe(true);
          }
        },
      ),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "outbound input handling returns typed failures",
  () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.constantFrom("https://[fe80::1%25eth0]/", "https://[::1%eth0]/"),
        ),
        (input) => {
          const result = parseSafeOutboundUrl(input);
          if (Result.isError(result)) {
            expect(SafeOutboundFetchError.is(result.error)).toBe(true);
            return;
          }
          expect(result.value.protocol).toBe("https:");
          expect(result.value.username).toBe("");
          expect(result.value.password).toBe("");
          expect(result.value.hash).toBe("");
        },
      ),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "outbound target handling follows literal address policy",
  async () => {
    await fc.assert(
      fc.asyncProperty(restrictedAddress, async (address) => {
        for (const host of embeddedHosts(address)) {
          const result = await validateOutboundFetchTarget(
            `https://[${host}]/`,
          );
          expect(Result.isError(result)).toBe(true);
        }
      }),
      propertyConfig({ seed: propertySeed(), numRuns: 30 }),
    );
  },
  propertyTestTimeout(5000),
);
