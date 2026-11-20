/**
 * The key dictation listens for, as the windows see it: the names the
 * native side uses (`dictation_hold_key.rs`) and how each one is labelled.
 * A hold key is a modifier held on its own; `combination` is Control,
 * Option (Alt) and Space together.
 */

import {
  formatShortcut,
  modifierLabel,
  shortcutKeycaps,
} from "./shortcut-keys";
import type {
  DesktopPlatform,
  KeyboardLayout,
  ShortcutKeys,
  ShortcutModifier,
} from "./shortcut-keys";

const HOLD_KEYS = [
  "fn",
  "rightOption",
  "rightCommand",
  "rightControl",
  "controlWindows",
  "combination",
] as const;

export type HoldKey = (typeof HOLD_KEYS)[number];

export const isHoldKey = (value: unknown): value is HoldKey =>
  typeof value === "string" && (HOLD_KEYS as readonly string[]).includes(value);

/** The modifier a right-side hold key is, or null for the others. */
const RIGHT_SIDE = {
  combination: null,
  controlWindows: null,
  fn: null,
  rightCommand: "super",
  rightControl: "control",
  rightOption: "alt",
} as const satisfies Record<HoldKey, ShortcutModifier | null>;

type HoldKeyLabelOptions = {
  holdKey: HoldKey;
  /** The combination's keys, for `combination`. */
  keys: ShortcutKeys;
  layout: KeyboardLayout | null;
  locale: string;
  platform: DesktopPlatform;
  /** The translated "Right {key}". */
  right: (key: string) => string;
};

/** One keycap per key held, ids stable per row. */
const holdKeyCaps = ({
  holdKey,
  keys,
  layout,
  locale,
  platform,
  right,
}: HoldKeyLabelOptions): { id: string; label: string }[] => {
  if (holdKey === "combination") {
    return shortcutKeycaps({ keys, layout, locale, platform });
  }
  if (holdKey === "fn") {
    return [{ id: "fn", label: "fn" }];
  }
  if (holdKey === "controlWindows") {
    // Named in the order people say it, as Windows apps do.
    return (["control", "super"] as const).map((modifier) => ({
      id: modifier,
      label: modifierLabel({ locale, modifier, platform }),
    }));
  }
  const modifier = RIGHT_SIDE[holdKey];
  return [
    {
      id: modifier,
      label: right(modifierLabel({ locale, modifier, platform })),
    },
  ];
};

/** One string for the hold key inside a sentence: `fn`, `Ctrl+Win`. */
export const formatHoldKey = (options: HoldKeyLabelOptions) =>
  options.holdKey === "combination"
    ? formatShortcut(options)
    : holdKeyCaps(options)
        .map((cap) => cap.label)
        .join("+");
