import { describe, expect, test } from "bun:test";

import {
  isMenuNavigationKey,
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
