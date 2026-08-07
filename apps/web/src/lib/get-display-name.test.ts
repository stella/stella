import { describe, expect, it } from "bun:test";

import { getDisplayName } from "./get-display-name";

describe("getDisplayName", () => {
  it("prefers the name when it has content", () => {
    expect(getDisplayName("Eva Schmidt", "eva@example.com")).toBe(
      "Eva Schmidt",
    );
  });

  // The bug this helper exists for: `user.name` is `notNull` but still
  // admits "", so a blank name reaches the UI as a nameless identity.
  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["null", null],
    ["undefined", undefined],
  ])("falls back to the email when the name is %s", (_label, name) => {
    expect(getDisplayName(name, "eva@example.com")).toBe("eva@example.com");
  });

  it("returns null when neither field is usable", () => {
    expect(getDisplayName("", "")).toBeNull();
    expect(getDisplayName(null, null)).toBeNull();
    expect(getDisplayName("  ", "  ")).toBeNull();
    expect(getDisplayName(undefined)).toBeNull();
  });

  it("trims the value it returns", () => {
    expect(getDisplayName("  Eva Schmidt  ")).toBe("Eva Schmidt");
    expect(getDisplayName(null, "  eva@example.com  ")).toBe("eva@example.com");
  });

  // Whatever comes back must be renderable as an identity: `getInitials`
  // returns "?" for a blank string, so a non-null result must never be one.
  it("never returns a blank string", () => {
    const inputs = ["", "   ", "\t\n", null, undefined, "Eva"];
    for (const name of inputs) {
      for (const email of inputs) {
        expect(getDisplayName(name, email)).not.toBe("");
      }
    }
  });
});
