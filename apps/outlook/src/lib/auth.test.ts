import { describe, expect, test } from "bun:test";

import { parseHandoffToken } from "@/lib/auth";

const EXPECTED_ORIGIN = "https://my.stll.app";

describe("Outlook sign-in handoff", () => {
  test("accepts a bounded token from the configured sign-in origin", () => {
    expect(
      parseHandoffToken({
        actualOrigin: EXPECTED_ORIGIN,
        expectedOrigin: EXPECTED_ORIGIN,
        raw: JSON.stringify({ token: "session-token", type: "stella:auth" }),
      }),
    ).toBe("session-token");
  });

  test("rejects a token sent from another origin", () => {
    expect(
      parseHandoffToken({
        actualOrigin: "https://attacker.example",
        expectedOrigin: EXPECTED_ORIGIN,
        raw: JSON.stringify({ token: "session-token", type: "stella:auth" }),
      }),
    ).toBeNull();
  });

  test("rejects missing origin metadata", () => {
    expect(
      parseHandoffToken({
        actualOrigin: undefined,
        expectedOrigin: EXPECTED_ORIGIN,
        raw: JSON.stringify({ token: "session-token", type: "stella:auth" }),
      }),
    ).toBeNull();
  });

  test("rejects malformed, empty, or oversized tokens", () => {
    const invalidPayloads = [
      "not-json",
      JSON.stringify({ token: "", type: "stella:auth" }),
      JSON.stringify({ token: "x".repeat(8193), type: "stella:auth" }),
      JSON.stringify({ token: "session-token", type: "unexpected" }),
    ];

    for (const raw of invalidPayloads) {
      expect(
        parseHandoffToken({
          actualOrigin: EXPECTED_ORIGIN,
          expectedOrigin: EXPECTED_ORIGIN,
          raw,
        }),
      ).toBeNull();
    }
  });
});
