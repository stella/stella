import { describe, expect, test } from "bun:test";

import { buildDialogStartAddress, parseHandoffToken } from "@/lib/auth";

describe("buildDialogStartAddress", () => {
  test("bootstraps the dialog on the task-pane origin", () => {
    expect(buildDialogStartAddress("https://outlook.example.test/path")).toBe(
      "https://outlook.example.test/dialog.html?parentOrigin=https%3A%2F%2Foutlook.example.test",
    );
  });
});

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
