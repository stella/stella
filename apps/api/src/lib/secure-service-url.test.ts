import { describe, expect, test } from "bun:test";

import { isTlsOrLoopbackUrl } from "@/api/lib/secure-service-url";

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

  test.each(["http://storage.example.com", "ftp://storage.example.com"])(
    "rejects remote plaintext or unrelated protocols: %s",
    (url) => {
      expect(isTlsOrLoopbackUrl(url, HTTP_TRANSPORT)).toBe(false);
    },
  );
});
