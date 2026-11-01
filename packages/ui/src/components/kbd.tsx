"use client";

import { useSyncExternalStore } from "react";
import type * as React from "react";

import { cn } from "../lib/utils";

/**
 * A key or a key combination, drawn as key caps.
 *
 * Give it `keys` and it spells modifiers the way the reader's platform does:
 * `["mod", "K"]` reads `⌘K` on Apple devices and `Ctrl+K` elsewhere. The
 * server and the first client render use the non-Apple spelling, and the
 * label switches once mounted, so hydration never disagrees. Children are
 * shown as written, for a key that needs no translation.
 *
 * `MenuShortcut` and `TooltipPopup`'s `shortcut` render through it, so a
 * shortcut reads the same in a menu, a tooltip and a hint.
 */
const Kbd = ({
  className,
  children,
  keys,
  variant = "cap",
  ...props
}: KbdProps) => {
  const platform = useKbdPlatform();
  return (
    <kbd
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-0.5 font-sans leading-none font-medium tabular-nums",
        KBD_VARIANT_CLASS_NAME[variant],
        className,
      )}
      data-slot="kbd"
      data-variant={variant}
      {...props}
    >
      {keys === undefined ? children : formatKeys(keys, platform)}
    </kbd>
  );
};

/** A modifier or named key `Kbd` spells per platform; anything else as is. */
type KbdNamedKey =
  | "mod"
  | "ctrl"
  | "alt"
  | "shift"
  | "enter"
  | "escape"
  | "backspace"
  | "delete"
  | "tab"
  | "up"
  | "down"
  | "left"
  | "right";

/**
 * A named key (see `KbdNamedKey`) or any other key (a letter, a digit, a
 * symbol), which is shown as written.
 */
type KbdKey = string;

type KbdPlatform = "apple" | "other";

/**
 * - `cap` (default): a boxed key cap, for a shortcut that stands on its own
 *   (a hint, a tooltip).
 * - `plain`: the keys as quiet text with no box, for the end of a row of
 *   labels (a menu item), where caps would crowd it.
 */
type KbdVariant = "cap" | "plain";

type KbdProps = React.ComponentProps<"kbd"> & {
  keys?: readonly KbdKey[] | undefined;
  variant?: KbdVariant | undefined;
};

const KBD_VARIANT_CLASS_NAME = {
  cap: "border-border bg-muted text-muted-foreground text-2xs h-5 min-w-5 rounded border px-1",
  plain: "text-foreground-label text-xs tracking-widest",
} as const satisfies Record<KbdVariant, string>;

const KEY_LABELS = {
  apple: {
    alt: "⌥",
    backspace: "⌫",
    ctrl: "⌃",
    delete: "⌦",
    down: "↓",
    enter: "↩",
    escape: "Esc",
    left: "←",
    mod: "⌘",
    right: "→",
    shift: "⇧",
    tab: "⇥",
    up: "↑",
  },
  other: {
    alt: "Alt",
    backspace: "Backspace",
    ctrl: "Ctrl",
    delete: "Del",
    down: "↓",
    enter: "Enter",
    escape: "Esc",
    left: "←",
    mod: "Ctrl",
    right: "→",
    shift: "Shift",
    tab: "Tab",
    up: "↑",
  },
} as const satisfies Record<KbdPlatform, Record<KbdNamedKey, string>>;

function isNamedKey(key: string): key is KbdNamedKey {
  return Object.hasOwn(KEY_LABELS.other, key);
}

/**
 * The combination as the platform writes it: Apple glyphs run together
 * (`⌘⇧K`), other platforms join words with `+` (`Ctrl+Shift+K`).
 */
function formatKeys(keys: readonly KbdKey[], platform: KbdPlatform): string {
  const labels = keys.map((key) =>
    isNamedKey(key) ? KEY_LABELS[platform][key] : key,
  );
  return labels.join(platform === "apple" ? "" : "+");
}

const APPLE_PLATFORM_PATTERN = /mac|iphone|ipad|ipod/iu;

/** What platform detection reads; `userAgentData` is not in every browser. */
type KbdNavigator = Pick<Navigator, "platform"> & {
  userAgentData?: { platform?: string | undefined } | undefined;
};

/**
 * The platform a navigator reports. A browser that has `userAgentData` may
 * leave its `platform` empty, so an empty name falls back to
 * `navigator.platform` as a missing one does.
 */
function kbdPlatformOf(nav: KbdNavigator): KbdPlatform {
  const name = nav.userAgentData?.platform || nav.platform;
  return APPLE_PLATFORM_PATTERN.test(name) ? "apple" : "other";
}

const detectKbdPlatform = (): KbdPlatform => kbdPlatformOf(navigator);

const subscribeToNothing = () => () => undefined;

/** The reader's platform once mounted; `other` on the server and in hydration. */
function useKbdPlatform(): KbdPlatform {
  return useSyncExternalStore(
    subscribeToNothing,
    detectKbdPlatform,
    () => "other",
  );
}

export { Kbd, formatKeys, kbdPlatformOf, useKbdPlatform };
export type {
  KbdKey,
  KbdNamedKey,
  KbdNavigator,
  KbdPlatform,
  KbdProps,
  KbdVariant,
};
