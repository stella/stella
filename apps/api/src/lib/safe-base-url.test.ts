import { describe, expect, test } from "bun:test";

import { validateSafeBaseURL } from "@/api/lib/safe-base-url";

describe("validateSafeBaseURL", () => {
  test("accepts an https public hostname", () => {
    const result = validateSafeBaseURL("https://api.openai.com/v1");
    expect(result.ok).toBe(true);
  });

  test("rejects http (non-HTTPS)", () => {
    const result = validateSafeBaseURL("http://api.openai.com/v1");
    expect(result.ok).toBe(false);
  });

  test("rejects unknown schemes", () => {
    expect(validateSafeBaseURL("ftp://example.com").ok).toBe(false);
    expect(validateSafeBaseURL("file:///etc/passwd").ok).toBe(false);
  });

  test("rejects malformed URLs", () => {
    expect(validateSafeBaseURL("not-a-url").ok).toBe(false);
    expect(validateSafeBaseURL("").ok).toBe(false);
  });

  test("rejects URLs with embedded credentials", () => {
    const result = validateSafeBaseURL("https://user:pass@example.com/v1");
    expect(result.ok).toBe(false);
  });

  test("rejects localhost variants", () => {
    expect(validateSafeBaseURL("https://localhost/v1").ok).toBe(false);
    expect(validateSafeBaseURL("https://api.localhost/v1").ok).toBe(false);
    expect(validateSafeBaseURL("https://service.local/v1").ok).toBe(false);
    expect(validateSafeBaseURL("https://api.internal/v1").ok).toBe(false);
    expect(validateSafeBaseURL("https://app.corp/v1").ok).toBe(false);
  });

  test("rejects IPv4 loopback", () => {
    expect(validateSafeBaseURL("https://127.0.0.1/v1").ok).toBe(false);
    expect(validateSafeBaseURL("https://127.1.2.3/v1").ok).toBe(false);
  });

  test("rejects AWS metadata service (link-local)", () => {
    expect(validateSafeBaseURL("https://169.254.169.254/").ok).toBe(false);
    expect(validateSafeBaseURL("https://169.254.0.1/").ok).toBe(false);
  });

  test("rejects RFC1918 private ranges", () => {
    expect(validateSafeBaseURL("https://10.0.0.1/v1").ok).toBe(false);
    expect(validateSafeBaseURL("https://172.16.0.1/v1").ok).toBe(false);
    expect(validateSafeBaseURL("https://172.31.255.255/v1").ok).toBe(false);
    expect(validateSafeBaseURL("https://192.168.1.1/v1").ok).toBe(false);
  });

  test("rejects 0.0.0.0/8 and CGNAT", () => {
    expect(validateSafeBaseURL("https://0.0.0.0/v1").ok).toBe(false);
    expect(validateSafeBaseURL("https://100.64.0.1/v1").ok).toBe(false);
  });

  test("rejects multicast and reserved ranges", () => {
    expect(validateSafeBaseURL("https://224.0.0.1/v1").ok).toBe(false);
    expect(validateSafeBaseURL("https://239.255.255.255/v1").ok).toBe(false);
    expect(validateSafeBaseURL("https://240.0.0.1/v1").ok).toBe(false);
    expect(validateSafeBaseURL("https://255.255.255.255/v1").ok).toBe(false);
  });

  test("rejects test/documentation IPv4 ranges", () => {
    expect(validateSafeBaseURL("https://192.0.2.1/v1").ok).toBe(false);
    expect(validateSafeBaseURL("https://198.51.100.1/v1").ok).toBe(false);
    expect(validateSafeBaseURL("https://203.0.113.1/v1").ok).toBe(false);
    expect(validateSafeBaseURL("https://198.18.0.1/v1").ok).toBe(false);
  });

  test("accepts public IPv4", () => {
    expect(validateSafeBaseURL("https://8.8.8.8/v1").ok).toBe(true);
    expect(validateSafeBaseURL("https://1.1.1.1/v1").ok).toBe(true);
  });

  test("rejects IPv6 loopback and unspecified", () => {
    expect(validateSafeBaseURL("https://[::1]/v1").ok).toBe(false);
    expect(validateSafeBaseURL("https://[::]/v1").ok).toBe(false);
  });

  test("rejects IPv6 link-local fe80::/10", () => {
    expect(validateSafeBaseURL("https://[fe80::1]/v1").ok).toBe(false);
    expect(validateSafeBaseURL("https://[febf::1]/v1").ok).toBe(false);
  });

  test("rejects IPv6 ULA fc00::/7", () => {
    expect(validateSafeBaseURL("https://[fc00::1]/v1").ok).toBe(false);
    expect(validateSafeBaseURL("https://[fd00::1]/v1").ok).toBe(false);
  });

  test("rejects IPv6 multicast ff00::/8", () => {
    expect(validateSafeBaseURL("https://[ff02::1]/v1").ok).toBe(false);
  });

  test("rejects IPv4-mapped IPv6 to loopback", () => {
    expect(validateSafeBaseURL("https://[::ffff:127.0.0.1]/v1").ok).toBe(false);
    expect(validateSafeBaseURL("https://[::ffff:169.254.169.254]/v1").ok).toBe(
      false,
    );
  });

  test("normalizes the URL on success", () => {
    const result = validateSafeBaseURL("https://API.OpenAI.com/v1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.url.startsWith("https://api.openai.com")).toBe(true);
  });
});
