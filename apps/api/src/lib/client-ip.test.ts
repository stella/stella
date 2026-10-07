import { describe, expect, test } from "bun:test";

import {
  AUTH_CLIENT_ADDRESS_HEADER,
  CLIENT_ADDRESS_SOURCE,
  FRONTEND_ADDRESS_HEADER,
  FRONTEND_VERIFY_HEADER,
  isTrustedProxy,
  normalizeRateLimitClientAddress,
  resolveRateLimitClientAddress,
  parseEdgeClientAddress,
  parseTrustedProxies,
  ORIGIN_VERIFY_HEADER,
  resolveClientAddress,
  resolveClientIp,
  resolveSignupRateLimitClientIp,
  sealEdgeHeaders,
  stampClientAddressHeader,
} from "@/api/lib/client-ip";
import { SIGNUP_RATE_LIMIT_IP_SOURCE } from "@/api/lib/client-ip-config";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";

const fakeServer = (peer: string | null) => ({
  requestIP: () => (peer === null ? null : { address: peer }),
});

describe("parseTrustedProxies", () => {
  test("returns an empty block list for an unset value", () => {
    const trusted = parseTrustedProxies(undefined);
    expect(isTrustedProxy("1.2.3.4", trusted)).toBe(false);
    expect(isTrustedProxy("::1", trusted)).toBe(false);
  });

  test("accepts comma-separated IPv4 CIDRs", () => {
    const trusted = parseTrustedProxies("10.0.0.0/8, 192.168.0.0/16");
    expect(isTrustedProxy("10.5.5.5", trusted)).toBe(true);
    expect(isTrustedProxy("192.168.1.1", trusted)).toBe(true);
    expect(isTrustedProxy("172.16.0.1", trusted)).toBe(false);
  });

  test("treats a bare IPv4 address as a /32", () => {
    const trusted = parseTrustedProxies("203.0.113.7");
    expect(isTrustedProxy("203.0.113.7", trusted)).toBe(true);
    expect(isTrustedProxy("203.0.113.8", trusted)).toBe(false);
  });

  test("accepts IPv6 CIDRs and bare addresses", () => {
    const trusted = parseTrustedProxies("2001:db8::/32, ::1");
    expect(isTrustedProxy("2001:db8:abcd::1", trusted)).toBe(true);
    expect(isTrustedProxy("::1", trusted)).toBe(true);
    expect(isTrustedProxy("fe80::1", trusted)).toBe(false);
  });

  test("skips malformed entries without crashing", () => {
    const trusted = parseTrustedProxies(
      "not-an-ip, 10.0.0.0/8, /24, 1.2.3.4/, 192.168.0.0 / 16",
    );
    expect(isTrustedProxy("10.1.2.3", trusted)).toBe(true);
    expect(isTrustedProxy("192.168.1.1", trusted)).toBe(true);
    expect(isTrustedProxy("0.0.0.0", trusted)).toBe(false);
    expect(isTrustedProxy("8.8.8.8", trusted)).toBe(false);
  });

  test("logs the entries it rejects in one warning", () => {
    const logs = installRecordingLogger();
    try {
      parseTrustedProxies("not-an-ip, 10.0.0.0/8, 1.2.3.4/40, /24");

      expect(
        logs.at("WARN").map(({ message, attributes }) => ({
          message,
          entries: attributes?.["trustedProxy.rejectedEntries"],
        })),
      ).toEqual([
        {
          message: "client_ip.trusted_proxy_entries_rejected",
          entries: "not-an-ip,1.2.3.4/40,/24",
        },
      ]);
    } finally {
      logs.restore();
    }
  });

  test("logs nothing when every entry is accepted", () => {
    const logs = installRecordingLogger();
    try {
      parseTrustedProxies("10.0.0.0/8, ::1");

      expect(logs.records).toEqual([]);
    } finally {
      logs.restore();
    }
  });
});

describe("resolveClientIp", () => {
  const request = (headers: Record<string, string> = {}) =>
    new Request("https://example/test", { headers });

  test("returns null when the runtime exposes no socket peer", () => {
    expect(
      resolveClientIp(request(), fakeServer(null), {
        trusted: parseTrustedProxies("10.0.0.0/8"),
      }),
    ).toBeNull();
  });

  test("returns the socket peer when no proxy is trusted", () => {
    const trusted = parseTrustedProxies(undefined);
    expect(
      resolveClientIp(
        request({ "cf-connecting-ip": "8.8.8.8" }),
        fakeServer("203.0.113.7"),
        { trusted },
      ),
    ).toBe("203.0.113.7");
  });

  test("ignores forwarded headers when peer is outside the trusted set", () => {
    const trusted = parseTrustedProxies("10.0.0.0/8");
    expect(
      resolveClientIp(
        request({
          "cf-connecting-ip": "8.8.8.8",
          "x-real-ip": "9.9.9.9",
          "x-forwarded-for": "10.10.10.10",
        }),
        fakeServer("203.0.113.7"),
        { trusted },
      ),
    ).toBe("203.0.113.7");
  });

  test("ignores provider-specific headers behind a generic trusted proxy", () => {
    const trusted = parseTrustedProxies("10.0.0.0/8");
    expect(
      resolveClientIp(
        request({
          "cf-connecting-ip": "8.8.8.8",
          "x-real-ip": "9.9.9.9",
          "x-forwarded-for": "198.51.100.23",
        }),
        fakeServer("10.1.2.3"),
        { trusted },
      ),
    ).toBe("198.51.100.23");
  });

  test("uses the first untrusted x-forwarded-for hop", () => {
    const trusted = parseTrustedProxies("10.0.0.0/8");
    expect(
      resolveClientIp(
        request({ "x-forwarded-for": "9.9.9.9, 198.51.100.23" }),
        fakeServer("10.1.2.3"),
        { trusted },
      ),
    ).toBe("198.51.100.23");
  });

  test("walks x-forwarded-for backwards through trusted proxies", () => {
    const trusted = parseTrustedProxies("10.0.0.0/8, 192.168.0.0/16");
    expect(
      resolveClientIp(
        request({
          "x-forwarded-for": "203.0.113.9, 192.168.1.20, 10.2.3.4",
        }),
        fakeServer("10.1.2.3"),
        { trusted },
      ),
    ).toBe("203.0.113.9");
  });

  test("ignores malformed forwarded header values", () => {
    const trusted = parseTrustedProxies("10.0.0.0/8");
    expect(
      resolveClientIp(
        request({ "cf-connecting-ip": "not-an-ip", "x-real-ip": "also-bad" }),
        fakeServer("10.1.2.3"),
        { trusted },
      ),
    ).toBe("10.1.2.3");
    expect(
      resolveClientIp(
        request({ "x-forwarded-for": "203.0.113.9, not-an-ip" }),
        fakeServer("10.1.2.3"),
        { trusted },
      ),
    ).toBe("10.1.2.3");
  });

  test("returns the trusted-proxy peer when all forwarded headers are missing", () => {
    const trusted = parseTrustedProxies("10.0.0.0/8");
    expect(
      resolveClientIp(request(), fakeServer("10.1.2.3"), { trusted }),
    ).toBe("10.1.2.3");
  });
});

describe("resolveSignupRateLimitClientIp", () => {
  const request = (headers: Record<string, string> = {}) =>
    new Request("https://example/test", { headers });

  test("does not create a shared bucket from an untrusted socket peer", () => {
    expect(
      resolveSignupRateLimitClientIp(
        request({ "x-forwarded-for": "198.51.100.5" }),
        fakeServer("203.0.113.7"),
        {
          source: SIGNUP_RATE_LIMIT_IP_SOURCE.trustedProxy,
          trusted: parseTrustedProxies(undefined),
        },
      ),
    ).toBeNull();
  });

  test("uses only the socket peer in explicit direct mode", () => {
    expect(
      resolveSignupRateLimitClientIp(
        request({ "x-forwarded-for": "198.51.100.5" }),
        fakeServer("203.0.113.7"),
        { source: SIGNUP_RATE_LIMIT_IP_SOURCE.direct },
      ),
    ).toBe("203.0.113.7");
  });

  test("returns a forwarded client only through a configured proxy", () => {
    expect(
      resolveSignupRateLimitClientIp(
        request({ "x-forwarded-for": "198.51.100.5" }),
        fakeServer("10.1.2.3"),
        {
          source: SIGNUP_RATE_LIMIT_IP_SOURCE.trustedProxy,
          trusted: parseTrustedProxies("10.0.0.0/8"),
        },
      ),
    ).toBe("198.51.100.5");
  });

  test("ignores spoofable provider headers for the shared signup bucket", () => {
    expect(
      resolveSignupRateLimitClientIp(
        request({
          "cf-connecting-ip": "8.8.8.8",
          "x-real-ip": "9.9.9.9",
          "x-forwarded-for": "198.51.100.5",
        }),
        fakeServer("10.1.2.3"),
        {
          source: SIGNUP_RATE_LIMIT_IP_SOURCE.trustedProxy,
          trusted: parseTrustedProxies("10.0.0.0/8"),
        },
      ),
    ).toBe("198.51.100.5");
  });

  test("does not use a trusted proxy peer when the client header is absent", () => {
    expect(
      resolveSignupRateLimitClientIp(request(), fakeServer("10.1.2.3"), {
        source: SIGNUP_RATE_LIMIT_IP_SOURCE.trustedProxy,
        trusted: parseTrustedProxies("10.0.0.0/8"),
      }),
    ).toBeNull();
  });
});

describe("edge client address", () => {
  const EDGE_HEADER = "cloudfront-viewer-address";
  const trusted = parseTrustedProxies("10.0.0.0/8");
  const request = (headers: Record<string, string> = {}) =>
    new Request("https://example/test", { headers });

  test("parses the address and drops the port", () => {
    expect(parseEdgeClientAddress("203.0.113.7:46532")).toBe("203.0.113.7");
    expect(parseEdgeClientAddress("2001:db8::1:443")).toBe("2001:db8::1");
    expect(
      parseEdgeClientAddress("2001:0db8:85a3:0000:0000:8a2e:0370:7334:46532"),
    ).toBe("2001:0db8:85a3:0000:0000:8a2e:0370:7334");
    expect(parseEdgeClientAddress("[2001:db8::1]:443")).toBe("2001:db8::1");
  });

  test("reads the bare format as the whole address", () => {
    expect(parseEdgeClientAddress("203.0.113.7", "bare")).toBe("203.0.113.7");
    expect(parseEdgeClientAddress(" 2001:db8::1:443 ", "bare")).toBe(
      "2001:db8::1:443",
    );
    expect(parseEdgeClientAddress("203.0.113.7:443", "bare")).toBeNull();
  });

  test("rejects values that are not an address with a port", () => {
    for (const value of [null, "", "203.0.113.7", "host:443", "1.2.3.4:x"]) {
      expect(parseEdgeClientAddress(value)).toBeNull();
    }
  });

  test("uses the edge header from a trusted peer, ahead of x-forwarded-for", () => {
    expect(
      resolveClientAddress(
        request({
          [EDGE_HEADER]: "203.0.113.7:443",
          "x-forwarded-for": "198.51.100.1",
        }),
        fakeServer("10.0.0.5"),
        { trusted, edgeHeader: EDGE_HEADER },
      ),
    ).toEqual({
      address: "203.0.113.7",
      source: CLIENT_ADDRESS_SOURCE.edgeHeader,
    });
  });

  test("ignores the edge header from a peer outside the trusted set", () => {
    expect(
      resolveClientAddress(
        request({ [EDGE_HEADER]: "203.0.113.7:443" }),
        fakeServer("198.51.100.9"),
        { trusted, edgeHeader: EDGE_HEADER },
      ),
    ).toEqual({
      address: "198.51.100.9",
      source: CLIENT_ADDRESS_SOURCE.peer,
    });
  });

  test("ignores the edge header unless one is configured", () => {
    expect(
      resolveClientAddress(
        request({ [EDGE_HEADER]: "203.0.113.7:443" }),
        fakeServer("10.0.0.5"),
        { trusted, edgeHeader: null },
      ),
    ).toEqual({ address: "10.0.0.5", source: CLIENT_ADDRESS_SOURCE.peer });
  });

  test("falls back to the forwarded chain when the edge header is absent", () => {
    expect(
      resolveClientAddress(
        request({ "x-forwarded-for": "203.0.113.7" }),
        fakeServer("10.0.0.5"),
        { trusted, edgeHeader: EDGE_HEADER },
      ),
    ).toEqual({
      address: "203.0.113.7",
      source: CLIENT_ADDRESS_SOURCE.forwardedFor,
    });
  });

  test("a client-chosen x-forwarded-for value does not change the address", () => {
    const resolve = (forwardedFor: string) =>
      resolveClientIp(
        request({
          [EDGE_HEADER]: "203.0.113.7:443",
          "x-forwarded-for": forwardedFor,
        }),
        fakeServer("10.0.0.5"),
        { trusted, edgeHeader: EDGE_HEADER },
      );

    expect(resolve("198.51.100.1")).toBe("203.0.113.7");
    expect(resolve("192.0.2.44, 198.51.100.1")).toBe("203.0.113.7");
  });

  test("the signup bucket uses the same edge address", () => {
    expect(
      resolveSignupRateLimitClientIp(
        request({ [EDGE_HEADER]: "203.0.113.7:443" }),
        fakeServer("10.0.0.5"),
        {
          source: SIGNUP_RATE_LIMIT_IP_SOURCE.trustedProxy,
          trusted,
          edgeHeader: EDGE_HEADER,
        },
      ),
    ).toBe("203.0.113.7");
  });
});

describe("stampClientAddressHeader", () => {
  test("replaces an incoming value with the resolved address", () => {
    const request = new Request("https://example/test", {
      headers: { [AUTH_CLIENT_ADDRESS_HEADER]: "198.51.100.1" },
    });
    stampClientAddressHeader(request, {
      address: "203.0.113.7",
      source: CLIENT_ADDRESS_SOURCE.peer,
    });
    expect(request.headers.get(AUTH_CLIENT_ADDRESS_HEADER)).toBe("203.0.113.7");
  });

  test("removes an incoming value when no address was resolved", () => {
    const request = new Request("https://example/test", {
      headers: { [AUTH_CLIENT_ADDRESS_HEADER]: "198.51.100.1" },
    });
    stampClientAddressHeader(request, null);
    expect(request.headers.get(AUTH_CLIENT_ADDRESS_HEADER)).toBeNull();
  });
});

describe("rate limit address normalization", () => {
  test("keeps IPv4 and mapped IPv4 addresses in the full-address counter", () => {
    for (const address of [
      "192.0.2.1",
      "::ffff:192.0.2.1",
      "::FFFF:c000:201",
    ]) {
      expect(normalizeRateLimitClientAddress(address)).toBe("192.0.2.1");
    }
    expect(normalizeRateLimitClientAddress("192.0.2.2")).toBe("192.0.2.2");
    expect(normalizeRateLimitClientAddress("::ffff:c000:202")).toBe(
      "192.0.2.2",
    );
  });

  test("normalizes the configured edge address before choosing the counter", () => {
    expect(
      resolveRateLimitClientAddress({
        request: new Request("https://example.test/", {
          headers: {
            "viewer-address": "[2001:0DB8:abcd:1234::9]:443",
            "x-forwarded-for": "198.51.100.1",
          },
        }),
        server: fakeServer("10.1.2.3"),
        clientAddressOptions: {
          trusted: parseTrustedProxies("10.0.0.0/8"),
          edgeHeader: "viewer-address",
        },
      }),
    ).toBe("2001:db8:abcd:1234::");
  });
});

describe("edge origin verification", () => {
  const EDGE_HEADER = "cloudfront-viewer-address";
  const CURRENT = "current-origin-value-0123456789abcdef";
  const NEXT = "next-origin-value-0123456789abcdef0123";
  const trusted = parseTrustedProxies("10.0.0.0/8");
  const options = {
    trusted,
    edgeHeader: EDGE_HEADER,
    originSecrets: [CURRENT, NEXT],
    edgeAddressFormat: "bare" as const,
  };
  const request = (headers: Record<string, string>) =>
    new Request("https://example/test", {
      headers: { "x-forwarded-for": "198.51.100.1", ...headers },
    });

  test("reads the edge address when the request carries a configured value", () => {
    for (const value of [CURRENT, NEXT]) {
      expect(
        resolveClientAddress(
          request({
            [EDGE_HEADER]: "203.0.113.7",
            [ORIGIN_VERIFY_HEADER]: value,
          }),
          fakeServer("10.0.0.5"),
          options,
        ),
      ).toEqual({
        address: "203.0.113.7",
        source: CLIENT_ADDRESS_SOURCE.edgeHeader,
      });
    }
  });

  test("uses the forwarded chain when the value is missing or different", () => {
    for (const headers of [
      { [EDGE_HEADER]: "203.0.113.7" },
      { [EDGE_HEADER]: "203.0.113.7", [ORIGIN_VERIFY_HEADER]: "other" },
      { [EDGE_HEADER]: "203.0.113.7", [ORIGIN_VERIFY_HEADER]: `${CURRENT}x` },
    ]) {
      expect(
        resolveClientAddress(request(headers), fakeServer("10.0.0.5"), options),
      ).toEqual({
        address: "198.51.100.1",
        source: CLIENT_ADDRESS_SOURCE.forwardedFor,
      });
    }
  });

  test("applies the same rule to the signup bucket", () => {
    const resolve = (headers: Record<string, string>) =>
      resolveSignupRateLimitClientIp(request(headers), fakeServer("10.0.0.5"), {
        source: SIGNUP_RATE_LIMIT_IP_SOURCE.trustedProxy,
        ...options,
      });
    expect(
      resolve({
        [EDGE_HEADER]: "203.0.113.7",
        [ORIGIN_VERIFY_HEADER]: CURRENT,
      }),
    ).toBe("203.0.113.7");
    expect(resolve({ [EDGE_HEADER]: "203.0.113.7" })).toBe("198.51.100.1");
  });

  test("sealing removes the verification header and keeps the resolved address", () => {
    const sealed = request({
      [EDGE_HEADER]: "203.0.113.7",
      [ORIGIN_VERIFY_HEADER]: CURRENT,
    });
    const address = resolveClientAddress(
      sealed,
      fakeServer("10.0.0.5"),
      options,
    );
    sealEdgeHeaders(sealed, address);
    expect(sealed.headers.get(ORIGIN_VERIFY_HEADER)).toBeNull();
    expect(resolveClientAddress(sealed, fakeServer("10.0.0.5"))).toEqual(
      address,
    );
  });
});

/*
 * Contract with the infrastructure repository (client-ip-config.ts holds the
 * full table): the frontend /api/* function writes the browser's bare address
 * to x-stella-viewer-address, the frontend distribution adds
 * x-stella-frontend-verify, and the API task receives the accepted values as
 * STELLA_FRONTEND_VERIFY_SECRET. The header names are fixed on both sides.
 */
describe("frontend edge address", () => {
  const FRONTEND_HEADER = FRONTEND_ADDRESS_HEADER;

  test("the header names match the infrastructure contract", () => {
    expect(FRONTEND_ADDRESS_HEADER).toBe("x-stella-viewer-address");
    expect(FRONTEND_VERIFY_HEADER).toBe("x-stella-frontend-verify");
    expect(ORIGIN_VERIFY_HEADER).toBe("x-stella-origin-verify");
  });

  const EDGE_HEADER = "cloudfront-viewer-address";
  const FRONTEND_CURRENT = "frontend-current-value-0123456789abcdef";
  const FRONTEND_NEXT = "frontend-next-value-0123456789abcdef0123";
  const ORIGIN = "origin-current-value-0123456789abcdef00";
  const PEER = "10.0.0.5";
  const trusted = parseTrustedProxies("10.0.0.0/8");
  const options = {
    trusted,
    edgeHeader: EDGE_HEADER,
    originSecrets: [ORIGIN],
    frontendSecrets: [FRONTEND_CURRENT, FRONTEND_NEXT],
  };
  // A browser call: the API edge names the frontend edge, and the frontend
  // edge names the browser.
  const browserCall = (headers: Record<string, string> = {}) =>
    new Request("https://example/test", {
      headers: {
        "x-forwarded-for": "198.51.100.1",
        [EDGE_HEADER]: "192.0.2.10:443",
        [ORIGIN_VERIFY_HEADER]: ORIGIN,
        [FRONTEND_HEADER]: "203.0.113.7",
        [FRONTEND_VERIFY_HEADER]: FRONTEND_CURRENT,
        ...headers,
      },
    });
  const resolve = (
    request: Request,
    overrides: NonNullable<Parameters<typeof resolveClientAddress>[2]> = {},
    peer = PEER,
  ) =>
    resolveClientAddress(request, fakeServer(peer), {
      ...options,
      ...overrides,
    });
  const viaApiEdge = {
    address: "192.0.2.10",
    source: CLIENT_ADDRESS_SOURCE.edgeHeader,
  };

  test("reads the browser address first when the frontend value matches", () => {
    for (const value of [FRONTEND_CURRENT, FRONTEND_NEXT]) {
      expect(resolve(browserCall({ [FRONTEND_VERIFY_HEADER]: value }))).toEqual(
        {
          address: "203.0.113.7",
          source: CLIENT_ADDRESS_SOURCE.frontendHeader,
        },
      );
    }
  });

  test("a forged frontend address without the frontend value falls to the API edge", () => {
    const forged = new Request("https://example/test", {
      headers: {
        [EDGE_HEADER]: "192.0.2.10:443",
        [ORIGIN_VERIFY_HEADER]: ORIGIN,
        [FRONTEND_HEADER]: "203.0.113.7",
      },
    });
    expect(resolve(forged)).toEqual(viaApiEdge);
  });

  test("a wrong frontend value is ignored", () => {
    for (const value of [
      "",
      "other",
      ORIGIN,
      `${FRONTEND_CURRENT}x`,
      FRONTEND_CURRENT.slice(0, -1),
      `${FRONTEND_CURRENT},${FRONTEND_NEXT}`,
      FRONTEND_CURRENT.toUpperCase(),
    ]) {
      expect(resolve(browserCall({ [FRONTEND_VERIFY_HEADER]: value }))).toEqual(
        viaApiEdge,
      );
    }
  });

  test("the origin value does not admit the frontend address", () => {
    expect(resolve(browserCall(), { frontendSecrets: [ORIGIN] })).toEqual({
      address: "192.0.2.10",
      source: CLIENT_ADDRESS_SOURCE.edgeHeader,
    });
  });

  test("stays inert unless frontend values are configured", () => {
    expect(resolve(browserCall(), { frontendSecrets: [] })).toEqual(viaApiEdge);
    expect(
      resolve(browserCall(), { frontendSecrets: [], edgeHeader: null }),
    ).toEqual({
      address: "198.51.100.1",
      source: CLIENT_ADDRESS_SOURCE.forwardedFor,
    });
  });

  test("is never read from a peer outside the trusted set", () => {
    expect(resolve(browserCall(), {}, "198.51.100.9")).toEqual({
      address: "198.51.100.9",
      source: CLIENT_ADDRESS_SOURCE.peer,
    });
  });

  test("reads bare IPv4 and IPv6 addresses", () => {
    for (const address of ["203.0.113.7", "2001:db8::1", "::ffff:192.0.2.1"]) {
      expect(
        resolve(browserCall({ [FRONTEND_HEADER]: ` ${address} ` })),
      ).toEqual({ address, source: CLIENT_ADDRESS_SOURCE.frontendHeader });
    }
  });

  test("a port, brackets or a malformed value fall through to the API edge", () => {
    for (const value of [
      "203.0.113.7:443",
      "[2001:db8::1]:443",
      "[2001:db8::1]",
      "203.0.113.7, 198.51.100.1",
      "unknown",
      "",
      "256.0.0.1",
      "2001:db8:::1",
    ]) {
      expect(resolve(browserCall({ [FRONTEND_HEADER]: value }))).toEqual(
        viaApiEdge,
      );
    }
  });

  test("the signup bucket uses the same precedence", () => {
    const signup = (headers: Record<string, string>) =>
      resolveSignupRateLimitClientIp(browserCall(headers), fakeServer(PEER), {
        source: SIGNUP_RATE_LIMIT_IP_SOURCE.trustedProxy,
        ...options,
      });
    expect(signup({})).toBe("203.0.113.7");
    expect(signup({ [FRONTEND_VERIFY_HEADER]: "other" })).toBe("192.0.2.10");
  });

  test("the rate limit counter keys on the browser address", () => {
    expect(
      resolveRateLimitClientAddress({
        request: browserCall({ [FRONTEND_HEADER]: "2001:db8:abcd:1234::9" }),
        server: fakeServer(PEER),
        clientAddressOptions: options,
      }),
    ).toBe("2001:db8:abcd:1234::");
  });

  test("sealing removes the frontend verification header", () => {
    const sealed = browserCall();
    const address = resolve(sealed);
    sealEdgeHeaders(sealed, address);
    expect(sealed.headers.get(FRONTEND_VERIFY_HEADER)).toBeNull();
    expect(sealed.headers.get(FRONTEND_ADDRESS_HEADER)).toBeNull();
    expect(sealed.headers.get(ORIGIN_VERIFY_HEADER)).toBeNull();
    expect(resolveClientAddress(sealed, fakeServer(PEER))).toEqual(address);
  });
});
