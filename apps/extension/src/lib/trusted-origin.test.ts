import { describe, expect, test } from "bun:test";

import { trustedStellaOriginFromUrl } from "./trusted-origin";

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
