import { describe, expect, test } from "bun:test";

import { parseMobileApiUrl, shouldAllowAndroidEmulatorHttp } from "./api-url";

describe("shouldAllowAndroidEmulatorHttp", () => {
  test.each([
    {
      buildMode: "production" as const,
      deviceKind: "emulator" as const,
      platform: "android",
    },
    {
      buildMode: "development" as const,
      deviceKind: "physical" as const,
      platform: "android",
    },
    {
      buildMode: "development" as const,
      deviceKind: "emulator" as const,
      platform: "ios",
    },
    {
      buildMode: "development" as const,
      deviceKind: "emulator" as const,
      platform: "web",
    },
  ])("rejects non-development Android emulator runtimes: %o", (runtime) => {
    expect(shouldAllowAndroidEmulatorHttp(runtime)).toBe(false);
  });

  test("allows the Android emulator alias in an Android development emulator", () => {
    expect(
      shouldAllowAndroidEmulatorHttp({
        buildMode: "development",
        deviceKind: "emulator",
        platform: "android",
      }),
    ).toBe(true);
  });
});

describe("parseMobileApiUrl", () => {
  test("normalizes an HTTPS API base URL", () => {
    expect(parseMobileApiUrl("https://api.example.com")).toBe(
      "https://api.example.com/",
    );
  });

  test.each([
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    "http://[::1]:3001",
  ])("allows loopback HTTP for local development: %s", (value) => {
    expect(parseMobileApiUrl(value)).toBe(`${value}/`);
  });

  test("allows the Android emulator host alias only when explicitly in development", () => {
    expect(
      parseMobileApiUrl("http://10.0.2.2:3001", {
        allowAndroidEmulatorHttp: true,
      }),
    ).toBe("http://10.0.2.2:3001/");
    expect(() => parseMobileApiUrl("http://10.0.2.2:3001")).toThrow();
  });

  test("preserves a self-hosted path prefix", () => {
    expect(parseMobileApiUrl("https://example.com/stella/api/")).toBe(
      "https://example.com/stella/api/",
    );
  });

  test.each([
    undefined,
    "not-a-url",
    "ftp://api.example.com",
    "http://api.example.com",
    "http://192.168.1.20:3001",
    "https://user:secret@api.example.com",
    "https://api.example.com?tenant=one",
    "https://api.example.com#config",
  ])("rejects an unsafe API URL: %p", (value) => {
    expect(() => parseMobileApiUrl(value)).toThrow();
  });
});
