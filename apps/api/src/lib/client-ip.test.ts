import { describe, expect, test } from "bun:test";

import {
  isTrustedProxy,
  parseTrustedProxies,
  resolveClientIp,
  resolveSignupRateLimitClientIp,
} from "@/api/lib/client-ip";
import { SIGNUP_RATE_LIMIT_IP_SOURCE } from "@/api/lib/client-ip-config";

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
