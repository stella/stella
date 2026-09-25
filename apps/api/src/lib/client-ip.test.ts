import { describe, expect, test } from "bun:test";

import {
  AUTH_CLIENT_ADDRESS_HEADER,
  CLIENT_ADDRESS_SOURCE,
  isTrustedProxy,
  parseEdgeClientAddress,
  parseTrustedProxies,
  resolveClientAddress,
  resolveClientIp,
  resolveSignupRateLimitClientIp,
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
