import { describe, expect, test } from "bun:test";

import { isDeferredEditorKeyDown } from "./PagedEditor";

type KeyDownOptions = {
  ctrlKey?: boolean;
  isComposing?: boolean;
  metaKey?: boolean;
};

const keyEvent = (key: string, options: KeyDownOptions = {}) => ({
  altKey: false,
  ctrlKey: options.ctrlKey === true,
  key,
  metaKey: options.metaKey === true,
  nativeEvent: {
    isComposing: options.isComposing === true,
  },
});

describe("deferred editor keydown detection", () => {
  test("replays edit and navigation keys while the hidden editor is deferred", () => {
    expect(isDeferredEditorKeyDown(keyEvent("Backspace"))).toBe(true);
    expect(isDeferredEditorKeyDown(keyEvent("Delete"))).toBe(true);
    expect(isDeferredEditorKeyDown(keyEvent("Enter"))).toBe(true);
    expect(isDeferredEditorKeyDown(keyEvent("ArrowLeft"))).toBe(true);
    expect(isDeferredEditorKeyDown(keyEvent("Tab"))).toBe(true);
  });

  test("replays editor modifier shortcuts while the hidden editor is deferred", () => {
    expect(isDeferredEditorKeyDown(keyEvent("a", { metaKey: true }))).toBe(
      true,
    );
    expect(isDeferredEditorKeyDown(keyEvent("A", { ctrlKey: true }))).toBe(
      true,
    );
    expect(isDeferredEditorKeyDown(keyEvent("z", { metaKey: true }))).toBe(
      true,
    );
  });

  test("does not claim unrelated browser modifier shortcuts", () => {
    expect(isDeferredEditorKeyDown(keyEvent("p", { metaKey: true }))).toBe(
      false,
    );
    expect(isDeferredEditorKeyDown(keyEvent("s", { ctrlKey: true }))).toBe(
      false,
    );
  });

  test("replays composition key events", () => {
    expect(
      isDeferredEditorKeyDown(keyEvent("Process", { isComposing: true })),
    ).toBe(true);
  });
});
