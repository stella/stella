import { describe, expect, test } from "bun:test";

import {
  isMenuNavigationKey,
  isTabPick,
  isTriggerErase,
  scheduleSearchFocus,
} from "./composer-submenu-search.logic";

describe("composer submenu search interactions", () => {
  test("keeps menu navigation keys available to the menu", () => {
    for (const key of ["Escape", "ArrowDown", "ArrowUp", "Enter"]) {
      expect(isMenuNavigationKey(key)).toBe(true);
    }
    for (const key of ["a", " ", "Backspace", "Tab"]) {
      expect(isMenuNavigationKey(key)).toBe(false);
    }
  });

  test("picks a highlighted row on a plain Tab, as Enter does", () => {
    const plainTab = {
      altKey: false,
      ctrlKey: false,
      key: "Tab",
      metaKey: false,
      shiftKey: false,
    };
    for (const targetRole of [
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
    ]) {
      expect(isTabPick({ ...plainTab, targetRole })).toBe(true);
    }
    // The search field and modified Tabs keep their focus movement.
    expect(isTabPick({ ...plainTab, targetRole: null })).toBe(false);
    expect(isTabPick({ ...plainTab, targetRole: "textbox" })).toBe(false);
    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) {
      expect(
        isTabPick({ ...plainTab, [modifier]: true, targetRole: "menuitem" }),
      ).toBe(false);
    }
    expect(
      isTabPick({ ...plainTab, key: "Enter", targetRole: "menuitem" }),
    ).toBe(false);
  });

  test("erases the trigger only on Backspace in an empty field", () => {
    expect(isTriggerErase("Backspace", "")).toBe(true);
    expect(isTriggerErase("Backspace", "c")).toBe(false);
    expect(isTriggerErase("Delete", "")).toBe(false);
    expect(isTriggerErase("a", "")).toBe(false);
  });

  test("focuses through the scheduled callback", () => {
    let scheduledCallback = () => {};
    let focusCount = 0;
    const scheduler = {
      clearTimeout: () => {
        scheduledCallback = () => {};
      },
      setTimeout: (callback: () => void) => {
        scheduledCallback = callback;
        return 7;
      },
    };

    scheduleSearchFocus({
      ref: {
        current: {
          focus: () => {
            focusCount += 1;
          },
        },
      },
      scheduler,
    });

    scheduledCallback();
    expect(focusCount).toBe(1);
  });

  test("cancels pending focus on cleanup", () => {
    let clearedTimeoutId = 0;
    let pending = false;
    const scheduler = {
      clearTimeout: (timeoutId: number) => {
        clearedTimeoutId = timeoutId;
        pending = false;
      },
      setTimeout: () => {
        pending = true;
        return 7;
      },
    };

    const cleanup = scheduleSearchFocus({
      ref: { current: null },
      scheduler,
    });
    expect(pending).toBe(true);

    cleanup();

    expect(clearedTimeoutId).toBe(7);
    expect(pending).toBe(false);
  });
});
