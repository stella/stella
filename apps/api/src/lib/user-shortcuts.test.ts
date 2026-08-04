import { describe, expect, test } from "bun:test";

import { normalizeUserShortcutsField } from "@/api/lib/user-shortcuts";

describe("normalizeUserShortcutsField", () => {
  test("passes through an absent field and clears empties", () => {
    expect(normalizeUserShortcutsField(undefined)).toBeUndefined();
    expect(normalizeUserShortcutsField(null)).toBeNull();
    expect(normalizeUserShortcutsField("")).toBeNull();
    expect(normalizeUserShortcutsField("   ")).toBeNull();
    expect(normalizeUserShortcutsField("{}")).toBeNull();
  });

  test("canonically re-serializes a valid map with sorted keys", () => {
    const result = normalizeUserShortcutsField(
      JSON.stringify({ toggleChat: "Mod+J", search: "Mod+P" }),
    );
    expect(result).toBe(
      JSON.stringify({ search: "Mod+P", toggleChat: "Mod+J" }),
    );
  });

  test("rejects non-JSON and non-object shapes", () => {
    expect(() => normalizeUserShortcutsField("not json")).toThrow();
    expect(() => normalizeUserShortcutsField("[]")).toThrow();
    expect(() => normalizeUserShortcutsField("42")).toThrow();
    expect(() => normalizeUserShortcutsField(42)).toThrow();
  });

  test("rejects non-string binding values", () => {
    expect(() =>
      normalizeUserShortcutsField(JSON.stringify({ search: 5 })),
    ).toThrow();
    expect(() =>
      normalizeUserShortcutsField(JSON.stringify({ search: "" })),
    ).toThrow();
  });

  test("rejects an oversized blob", () => {
    const huge = JSON.stringify({ search: "M".repeat(5000) });
    expect(() => normalizeUserShortcutsField(huge)).toThrow();
  });

  test("rejects too many entries", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 100; i += 1) {
      many[`k${i}`] = "Mod+A";
    }
    expect(() => normalizeUserShortcutsField(JSON.stringify(many))).toThrow();
  });
});
