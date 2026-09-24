import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { normalizeUserShortcutsField } from "@/api/lib/user-shortcuts";

const normalized = (value: unknown) => {
  const result = normalizeUserShortcutsField(value);
  return Result.isError(result)
    ? panic(`Unexpected rejection: ${result.error.message}`)
    : result.value;
};

const rejectionOf = (value: unknown): string => {
  const result = normalizeUserShortcutsField(value);
  return Result.isError(result)
    ? result.error.message
    : panic("Expected the shortcuts to be rejected");
};

describe("normalizeUserShortcutsField", () => {
  test("passes through an absent field and clears empties", () => {
    expect(normalized(undefined)).toBeUndefined();
    expect(normalized(null)).toBeNull();
    expect(normalized("")).toBeNull();
    expect(normalized("   ")).toBeNull();
    expect(normalized("{}")).toBeNull();
  });

  test("canonically re-serializes a valid map with sorted keys", () => {
    const result = normalized(
      JSON.stringify({ toggleChat: "Mod+J", search: "Mod+P" }),
    );
    expect(result).toBe(
      JSON.stringify({ search: "Mod+P", toggleChat: "Mod+J" }),
    );
  });

  test("rejects non-JSON and non-object shapes", () => {
    expect(rejectionOf("not json")).toBe("Invalid keyboard shortcuts");
    expect(rejectionOf("[]")).toBe("Invalid keyboard shortcuts");
    expect(rejectionOf("42")).toBe("Invalid keyboard shortcuts");
    expect(rejectionOf(42)).toBe("Invalid keyboard shortcuts");
  });

  test("rejects non-string binding values", () => {
    expect(rejectionOf(JSON.stringify({ search: 5 }))).toBe(
      "Invalid keyboard shortcuts",
    );
    expect(rejectionOf(JSON.stringify({ search: "" }))).toBe(
      "Invalid keyboard shortcuts",
    );
  });

  test("rejects an oversized blob", () => {
    const huge = JSON.stringify({ search: "M".repeat(5000) });
    expect(rejectionOf(huge)).toBe("Invalid keyboard shortcuts");
  });

  test("rejects too many entries", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 100; i += 1) {
      many[`k${i}`] = "Mod+A";
    }
    expect(rejectionOf(JSON.stringify(many))).toBe(
      "Invalid keyboard shortcuts",
    );
  });
});
