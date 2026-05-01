import { describe, expect, test } from "bun:test";

import { isReadOnlyEditKey } from "./readOnlyEditAttempt";

const keyEvent = (
  key: string,
  modifiers: Partial<
    Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey">
  > = {},
) => ({
  altKey: modifiers.altKey ?? false,
  ctrlKey: modifiers.ctrlKey ?? false,
  key,
  metaKey: modifiers.metaKey ?? false,
});

describe("readonly edit attempt detection", () => {
  test("treats text input and deletion keys as edit attempts", () => {
    expect(isReadOnlyEditKey(keyEvent("a"))).toBe(true);
    expect(isReadOnlyEditKey(keyEvent(" "))).toBe(true);
    expect(isReadOnlyEditKey(keyEvent("Backspace"))).toBe(true);
    expect(isReadOnlyEditKey(keyEvent("Delete"))).toBe(true);
    expect(isReadOnlyEditKey(keyEvent("Enter"))).toBe(true);
  });

  test("treats formatting and clipboard mutation shortcuts as edit attempts", () => {
    expect(isReadOnlyEditKey(keyEvent("v", { metaKey: true }))).toBe(true);
    expect(isReadOnlyEditKey(keyEvent("x", { ctrlKey: true }))).toBe(true);
    expect(isReadOnlyEditKey(keyEvent("b", { metaKey: true }))).toBe(true);
    expect(isReadOnlyEditKey(keyEvent("z", { ctrlKey: true }))).toBe(true);
  });

  test("allows navigation, selection, and copy shortcuts", () => {
    expect(isReadOnlyEditKey(keyEvent("ArrowRight"))).toBe(false);
    expect(isReadOnlyEditKey(keyEvent("Escape"))).toBe(false);
    expect(isReadOnlyEditKey(keyEvent("Tab"))).toBe(false);
    expect(isReadOnlyEditKey(keyEvent("c", { metaKey: true }))).toBe(false);
    expect(isReadOnlyEditKey(keyEvent("a", { ctrlKey: true }))).toBe(false);
    expect(isReadOnlyEditKey(keyEvent("e", { altKey: true }))).toBe(false);
  });
});
