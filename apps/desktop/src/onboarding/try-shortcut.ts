/**
 * Live feedback while the user tries the clipboard shortcut: which keycaps
 * are held, and what a wrong key means. Success itself never comes from
 * here: the OS takes the registered combination before the window sees it,
 * so the native shortcut handler reports it.
 */

import type { ShortcutKeys, ShortcutModifier } from "../shared/shortcut-keys";

export type TryFeedback =
  | { type: "idle" }
  | { type: "progress" }
  | { modifier: ShortcutModifier; type: "extraModifier" }
  | { missing: ShortcutModifier[]; type: "missingModifiers" }
  | { code: string; type: "wrongKey" };

/** What the held modifiers alone say, before any other key. */
export const feedbackForModifiers = (
  shortcut: ShortcutKeys,
  held: readonly ShortcutModifier[],
): TryFeedback => {
  const extra = held.find((modifier) => !shortcut.modifiers.includes(modifier));
  if (extra) {
    return { modifier: extra, type: "extraModifier" };
  }
  return held.length > 0 ? { type: "progress" } : { type: "idle" };
};

type KeyFeedbackOptions = {
  code: string;
  held: readonly ShortcutModifier[];
  shortcut: ShortcutKeys;
};

/** What a non-modifier key means. The right key with the right modifiers
 *  gives no feedback: the native handler reports that press. */
export const feedbackForKey = ({
  code,
  held,
  shortcut,
}: KeyFeedbackOptions): TryFeedback => {
  const modifiers = feedbackForModifiers(shortcut, held);
  if (modifiers.type === "extraModifier") {
    return modifiers;
  }
  if (code !== shortcut.code) {
    return { code, type: "wrongKey" };
  }
  const missing = shortcut.modifiers.filter(
    (modifier) => !held.includes(modifier),
  );
  return missing.length > 0
    ? { missing, type: "missingModifiers" }
    : { type: "progress" };
};
