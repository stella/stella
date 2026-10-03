import { describe, expect, test } from "bun:test";

import { typedCharacter } from "@stll/ui/typed-character";

import {
  isMenuNavigationKey,
  isTabPick,
  isTriggerErase,
  POPUP_KEY_ROUTE,
  routePopupKey,
  scheduleSearchFocus,
} from "./composer-submenu-search.logic";

type KeystrokeFields = {
  altGraph?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  key: string;
  metaKey?: boolean;
};

// Realistic keydown fields, read through typedCharacter as the popup does.
const routeKeystroke = ({
  hasTrigger = true,
  value = "e",
  ...fields
}: KeystrokeFields & { hasTrigger?: boolean; value?: string }) =>
  routePopupKey({
    character: typedCharacter({
      altKey: fields.altKey ?? false,
      ctrlKey: fields.ctrlKey ?? false,
      getModifierState: (modifier) =>
        modifier === "AltGraph" && (fields.altGraph ?? false),
      isComposing: fields.isComposing ?? false,
      key: fields.key,
      metaKey: fields.metaKey ?? false,
    }),
    hasTrigger,
    key: fields.key,
    value,
  });

describe("routePopupKey", () => {
  test("sends every typed character and deletion back to the field", () => {
    for (const key of ["e", "E", "1", "@", "ř", "ß", "ع", "😀"]) {
      expect(routeKeystroke({ key })).toBe(POPUP_KEY_ROUTE.search);
    }
    // macOS Option types "@" on Czech, Slovak and German layouts.
    expect(routeKeystroke({ altKey: true, key: "@" })).toBe(
      POPUP_KEY_ROUTE.search,
    );
    // Windows AltGr arrives as Ctrl+Alt, with or without the AltGraph state.
    expect(routeKeystroke({ altKey: true, ctrlKey: true, key: "@" })).toBe(
      POPUP_KEY_ROUTE.search,
    );
    expect(
      routeKeystroke({
        altGraph: true,
        altKey: true,
        ctrlKey: true,
        key: "@",
      }),
    ).toBe(POPUP_KEY_ROUTE.search);
    for (const key of ["Backspace", "Delete"]) {
      expect(routeKeystroke({ key })).toBe(POPUP_KEY_ROUTE.search);
    }
  });

  test("Backspace with an empty query erases the trigger, as in the field", () => {
    expect(routeKeystroke({ key: "Backspace", value: "" })).toBe(
      POPUP_KEY_ROUTE.eraseTrigger,
    );
    // The (+) submenus have no trigger to erase.
    expect(
      routeKeystroke({ hasTrigger: false, key: "Backspace", value: "" }),
    ).toBe(POPUP_KEY_ROUTE.search);
  });

  test("leaves navigation, Space, command chords and IME to the menu", () => {
    for (const key of [
      "ArrowDown",
      "ArrowUp",
      "Enter",
      "Escape",
      "Tab",
      "Home",
      " ",
      "Shift",
      "F2",
      "Dead",
    ]) {
      expect(routeKeystroke({ key })).toBe(POPUP_KEY_ROUTE.menu);
    }
    expect(routeKeystroke({ key: "a", metaKey: true })).toBe(
      POPUP_KEY_ROUTE.menu,
    );
    expect(routeKeystroke({ ctrlKey: true, key: "a" })).toBe(
      POPUP_KEY_ROUTE.menu,
    );
    expect(routeKeystroke({ isComposing: true, key: "a" })).toBe(
      POPUP_KEY_ROUTE.menu,
    );
  });
});

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
