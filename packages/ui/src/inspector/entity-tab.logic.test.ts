import { describe, expect, test } from "bun:test";

import {
  isEntityTabCloseGesture,
  resolveEntityTabActivateHandler,
  resolveEntityTabCloseHandler,
} from "./entity-tab.logic";

describe("isEntityTabCloseGesture", () => {
  test("button 1 (middle-click) is the close gesture", () => {
    expect(isEntityTabCloseGesture(1)).toBe(true);
  });

  test("the primary button (0) is not", () => {
    expect(isEntityTabCloseGesture(0)).toBe(false);
  });

  test("the secondary button (2) is not", () => {
    expect(isEntityTabCloseGesture(2)).toBe(false);
  });
});

describe("resolveEntityTabCloseHandler", () => {
  test("a middle-click with a close handler resolves to it", () => {
    const onClose = () => undefined;
    expect(resolveEntityTabCloseHandler(1, onClose)).toBe(onClose);
  });

  test("a middle-click with no close handler resolves to nothing", () => {
    expect(resolveEntityTabCloseHandler(1, undefined)).toBeUndefined();
  });

  test("any other button resolves to nothing, even with a close handler", () => {
    const onClose = () => undefined;
    expect(resolveEntityTabCloseHandler(0, onClose)).toBeUndefined();
    expect(resolveEntityTabCloseHandler(2, onClose)).toBeUndefined();
  });
});

describe("resolveEntityTabActivateHandler", () => {
  test("returns the host's onSelect as-is", () => {
    const onSelect = () => undefined;
    expect(resolveEntityTabActivateHandler(onSelect)).toBe(onSelect);
  });

  test("returns a callable no-op when there's no onSelect", () => {
    const handler = resolveEntityTabActivateHandler(undefined);
    expect(() => handler()).not.toThrow();
  });
});
