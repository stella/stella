import { describe, expect, test } from "bun:test";

import {
  isRailwayPrivateHostname,
  isSecureGotenbergUrl,
  isTlsOrLoopbackUrl,
} from "@/api/lib/secure-service-url";

const HTTP_TRANSPORT = {
  plaintextProtocol: "http:",
  tlsProtocol: "https:",
} as const;

describe("secure service URL", () => {
  test.each([
    "https://storage.example.com",
    "http://localhost:9000",
    "http://127.0.0.1:9000",
    "http://[::1]:9000",
  ])("accepts TLS or loopback: %s", (url) => {
    expect(isTlsOrLoopbackUrl(url, HTTP_TRANSPORT)).toBe(true);
  });

  test.each([
    "http://storage.example.com",
    "ftp://storage.example.com",
    "not a URL",
  ])("rejects remote plaintext or unrelated protocols: %s", (url) => {
    expect(isTlsOrLoopbackUrl(url, HTTP_TRANSPORT)).toBe(false);
  });

  test.each([
    ["postgres.railway.internal", true],
    ["REDIS.RAILWAY.INTERNAL", true],
    ["railway.internal", false],
    ["postgres.railway.internal.example.com", false],
  ])("classifies Railway private hostnames: %s", (hostname, expected) => {
    expect(isRailwayPrivateHostname(hostname)).toBe(expected);
  });

  test.each([
    "https://converter.example.com",
    "http://localhost:3003",
    "http://gotenberg:3000",
    "http://gotenberg.railway.internal:3000",
  ])("accepts a Gotenberg endpoint on a protected channel: %s", (url) => {
    expect(isSecureGotenbergUrl(url)).toBe(true);
  });

  test.each([
    "http://converter.example.com",
    "http://10.0.0.20:3000",
    "http://gotenberg:3001",
    "http://gotenberg:3000@evil.example.com",
    "not a URL",
  ])("rejects a Gotenberg endpoint on an open channel: %s", (url) => {
    expect(isSecureGotenbergUrl(url)).toBe(false);
  });
});
