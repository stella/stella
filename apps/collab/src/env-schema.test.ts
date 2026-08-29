import { describe, expect, test } from "bun:test";

import { isSecureStellaApiUrl } from "./env-schema";

describe("Stella API transport", () => {
  test.each([
    "https://api.example.test",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    "http://[::1]:3001",
  ])("accepts secure or loopback URL %s", (url) => {
    expect(isSecureStellaApiUrl(url)).toBe(true);
  });

  test.each(["http://api.example.test", "ftp://api.example.test", "invalid"])(
    "rejects insecure API URL %s",
    (url) => {
      expect(isSecureStellaApiUrl(url)).toBe(false);
    },
  );
});
