import { describe, expect, test } from "bun:test";

import {
  parseTrustedOriginList,
  trustedStellaOriginFromUrl,
} from "./trusted-origin";

describe("build-time origin list", () => {
  test("defaults to the hosted origins and accepts exact HTTPS origins", () => {
    expect(parseTrustedOriginList(undefined)).toEqual([
      "https://app.stll.app",
      "https://my.stll.app",
      "https://staging.stll.app",
    ]);
    expect(
      parseTrustedOriginList(
        " https://stella.example.org, https://law.example.net ",
      ),
    ).toEqual(["https://stella.example.org", "https://law.example.net"]);
  });

  test("fails the build on non-origin or non-HTTPS entries", () => {
    expect(() => parseTrustedOriginList("http://stella.example.org")).toThrow(
      TypeError,
    );
    expect(() =>
      parseTrustedOriginList("https://stella.example.org/app"),
    ).toThrow(TypeError);
  });
});

describe("stella extension origin trust", () => {
  test("accepts only exact hosted app origins", () => {
    expect(trustedStellaOriginFromUrl("https://my.stll.app/chat")).toBe(
      "https://my.stll.app",
    );
    expect(trustedStellaOriginFromUrl("https://staging.stll.app/chat")).toBe(
      "https://staging.stll.app",
    );
    expect(trustedStellaOriginFromUrl("https://evil.stll.app/chat")).toBeNull();
    expect(trustedStellaOriginFromUrl("https://stll.app/chat")).toBeNull();
  });

  test("keeps each loopback port as a distinct origin", () => {
    expect(trustedStellaOriginFromUrl("http://localhost:3210/chat")).toBe(
      "http://localhost:3210",
    );
    expect(trustedStellaOriginFromUrl("http://127.0.0.1:3210/chat")).toBe(
      "http://127.0.0.1:3210",
    );
    expect(
      trustedStellaOriginFromUrl("http://localhost.example/chat"),
    ).toBeNull();
  });
});
