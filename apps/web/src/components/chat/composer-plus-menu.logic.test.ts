import { describe, expect, test } from "bun:test";

import {
  COMPOSER_MENU_SHORTCUT,
  resolveComposerMenuShortcut,
} from "@/components/chat/composer-plus-menu.logic";

const baseOptions = {
  altKey: false,
  ctrlKey: false,
  hasContext: true,
  hasSkills: true,
  isAltGraph: false,
  isComposing: false,
  isEditorEmpty: true,
  metaKey: false,
};

describe("resolveComposerMenuShortcut", () => {
  test("opens Skills for slash in a blank skills-enabled composer", () => {
    expect(resolveComposerMenuShortcut({ ...baseOptions, key: "/" })).toBe(
      COMPOSER_MENU_SHORTCUT.skills,
    );
  });

  test("opens Context for at-sign in a blank context-enabled composer", () => {
    expect(resolveComposerMenuShortcut({ ...baseOptions, key: "@" })).toBe(
      COMPOSER_MENU_SHORTCUT.context,
    );
  });

  test("leaves shortcuts to TipTap after the composer has content", () => {
    expect(
      resolveComposerMenuShortcut({
        ...baseOptions,
        isEditorEmpty: false,
        key: "/",
      }),
    ).toBeNull();
  });

  test("does not intercept unavailable menus", () => {
    expect(
      resolveComposerMenuShortcut({
        ...baseOptions,
        hasSkills: false,
        key: "/",
      }),
    ).toBeNull();
  });

  test("preserves command shortcuts and IME composition", () => {
    expect(
      resolveComposerMenuShortcut({
        ...baseOptions,
        ctrlKey: true,
        key: "/",
      }),
    ).toBeNull();
    expect(
      resolveComposerMenuShortcut({
        ...baseOptions,
        isComposing: true,
        key: "/",
      }),
    ).toBeNull();
  });

  test("allows AltGraph printable characters", () => {
    expect(
      resolveComposerMenuShortcut({
        ...baseOptions,
        altKey: true,
        ctrlKey: true,
        isAltGraph: true,
        key: "@",
      }),
    ).toBe(COMPOSER_MENU_SHORTCUT.context);
  });
});
