import { describe, expect, test } from "bun:test";

import {
  feedbackForKey,
  feedbackForModifiers,
} from "../src/onboarding/try-shortcut";
import { SHORTCUT_MODIFIERS } from "../src/shared/shortcut-keys";
import type { ShortcutModifier } from "../src/shared/shortcut-keys";

const SHORTCUT = { code: "KeyV", modifiers: ["shift", "super"] } as const;
const shortcut = { code: SHORTCUT.code, modifiers: [...SHORTCUT.modifiers] };
const shortcutModifiers = new Set<ShortcutModifier>(shortcut.modifiers);

/** Every subset of the four modifiers. */
const modifierSets = () => {
  let sets: ShortcutModifier[][] = [[]];
  for (const modifier of SHORTCUT_MODIFIERS) {
    sets = sets.flatMap((set) => [set, [...set, modifier]]);
  }
  return sets;
};
const MODIFIER_SETS = modifierSets();

describe("try-it feedback", () => {
  test("a modifier outside the shortcut is named before anything else", () => {
    for (const held of MODIFIER_SETS) {
      const extra = held.find((modifier) => !shortcutModifiers.has(modifier));
      for (const code of ["KeyV", "KeyC"]) {
        const feedback = feedbackForKey({ code, held, shortcut });
        if (extra) {
          expect(feedback).toEqual({ modifier: extra, type: "extraModifier" });
        } else {
          expect(feedback.type).not.toBe("extraModifier");
        }
      }
    }
  });

  test("the right key reports exactly the missing modifiers", () => {
    for (const held of MODIFIER_SETS) {
      if (held.some((modifier) => !shortcutModifiers.has(modifier))) {
        continue;
      }
      const missing = shortcut.modifiers.filter(
        (modifier) => !held.includes(modifier),
      );
      expect(feedbackForKey({ code: "KeyV", held, shortcut })).toEqual(
        missing.length > 0
          ? { missing, type: "missingModifiers" }
          : { type: "progress" },
      );
    }
  });

  test("another key is named as the key pressed", () => {
    expect(feedbackForKey({ code: "KeyC", held: ["super"], shortcut })).toEqual(
      {
        code: "KeyC",
        type: "wrongKey",
      },
    );
  });

  test("held modifiers alone show progress or nothing", () => {
    expect(feedbackForModifiers(shortcut, [])).toEqual({ type: "idle" });
    expect(feedbackForModifiers(shortcut, ["super"])).toEqual({
      type: "progress",
    });
    expect(feedbackForModifiers(shortcut, ["alt"])).toEqual({
      modifier: "alt",
      type: "extraModifier",
    });
  });
});
