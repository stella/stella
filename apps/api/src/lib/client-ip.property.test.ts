import { expect, test } from "bun:test";
import fc from "fast-check";
import { isIP } from "node:net";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import {
  CLIENT_ADDRESS_SOURCE,
  isTrustedProxy,
  parseEdgeClientAddress,
  parseTrustedProxies,
  resolveClientAddress,
} from "@/api/lib/client-ip";

const octet = fc.integer({ min: 0, max: 255 });
const address = fc
  .tuple(octet, octet, octet, octet)
  .map((parts) => parts.join("."));
const proxyOctet = fc.integer({ min: 1, max: 254 });

test(
  "client address handling stops at the first untrusted hop",
  () => {
    fc.assert(
      fc.property(
        proxyOctet,
        octet,
        octet,
        octet,
        fc.array(address, { maxLength: 8 }),
        fc.array(octet, { maxLength: 8 }),
        (network, a, b, c, spoofed, proxyHosts) => {
          const boundary = `203.0.113.${a}`;
          const peer = `10.${network}.${b}.${c}`;
          const proxies = proxyHosts.map((host) => `10.${network}.0.${host}`);
          const trusted = parseTrustedProxies(`10.${network}.0.0/16`);
          const request = new Request("https://example.test/", {
            headers: {
              "x-forwarded-for": [...spoofed, boundary, ...proxies].join(", "),
            },
          });
          expect(isTrustedProxy(peer, trusted)).toBe(true);
          expect(isTrustedProxy(boundary, trusted)).toBe(false);
          expect(
            resolveClientAddress(
              request,
              { requestIP: () => ({ address: peer }) },
              {
                trusted,
                edgeHeader: null,
              },
            ),
          ).toEqual({
            address: boundary,
            source: CLIENT_ADDRESS_SOURCE.forwardedFor,
          });
        },
      ),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "client address handling ignores headers from an untrusted peer",
  () => {
    fc.assert(
      fc.property(
        address,
        fc.array(address, { minLength: 1, maxLength: 8 }),
        (peer, chain) => {
          const request = new Request("https://example.test/", {
            headers: {
              "x-forwarded-for": chain.join(", "),
              "x-viewer-address": `${chain.at(0)}:443`,
            },
          });
          expect(
            resolveClientAddress(
              request,
              { requestIP: () => ({ address: peer }) },
              {
                trusted: parseTrustedProxies(null),
                edgeHeader: "x-viewer-address",
              },
            ),
          ).toEqual({ address: peer, source: CLIENT_ADDRESS_SOURCE.peer });
        },
      ),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "proxy address handling follows configured subnet membership",
  () => {
    fc.assert(
      fc.property(proxyOctet, octet, octet, octet, (network, a, b, c) => {
        const trusted = parseTrustedProxies(
          `10.${network}.0.0/16, 2001:db8::/32`,
        );
        expect(isTrustedProxy(`10.${network}.${a}.${b}`, trusted)).toBe(true);
        expect(
          isTrustedProxy(`10.${(network + 1) % 256}.${a}.${b}`, trusted),
        ).toBe(false);
        expect(
          isTrustedProxy(
            `2001:db8:${a.toString(16)}::${c.toString(16)}`,
            trusted,
          ),
        ).toBe(true);
        expect(
          isTrustedProxy(
            `2001:db9:${a.toString(16)}::${c.toString(16)}`,
            trusted,
          ),
        ).toBe(false);
      }),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "edge address handling preserves valid addresses",
  () => {
    fc.assert(
      fc.property(address, fc.integer({ min: 0, max: 65_535 }), (ip, port) => {
        expect(parseEdgeClientAddress(` ${ip}:${port} `)).toBe(ip);
        const ipv6 = `2001:db8::${port.toString(16)}`;
        expect(parseEdgeClientAddress(`[${ipv6}]:${port}`)).toBe(ipv6);
        expect(parseEdgeClientAddress(`${ipv6}:${port}`)).toBe(ipv6);
      }),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "edge address handling only returns IP addresses",
  () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.constantFrom(
            "a@127.0.0.1:443",
            "127.1:443",
            "0x7f000001:443",
            "[::1]:x",
          ),
        ),
        (value) => {
          const result = parseEdgeClientAddress(value);
          if (result !== null) {
            expect(isIP(result)).not.toBe(0);
          }
        },
      ),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(5000),
);
