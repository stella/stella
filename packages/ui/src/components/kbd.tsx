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
const Kbd = ({ className, children, keys, ...props }: KbdProps) => {
  const platform = useKbdPlatform();
  return (
    <kbd
      className={cn(
        "border-border bg-muted text-muted-foreground text-2xs inline-flex h-5 min-w-5 shrink-0 items-center justify-center gap-0.5 rounded border px-1 font-sans leading-none font-medium tabular-nums",
        className,
      )}
      data-slot="kbd"
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

// Any other key (a letter, a digit, a symbol) is shown as written.
type KbdKey = KbdNamedKey | string;

type KbdPlatform = "apple" | "other";

type KbdProps = React.ComponentProps<"kbd"> & {
  keys?: readonly KbdKey[] | undefined;
};

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

function detectKbdPlatform(): KbdPlatform {
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const name = nav.userAgentData?.platform ?? nav.platform;
  return APPLE_PLATFORM_PATTERN.test(name) ? "apple" : "other";
}

const subscribeToNothing = () => () => undefined;

/** The reader's platform once mounted; `other` on the server and in hydration. */
function useKbdPlatform(): KbdPlatform {
  return useSyncExternalStore(
    subscribeToNothing,
    detectKbdPlatform,
    () => "other",
  );
}

export { Kbd, formatKeys, useKbdPlatform };
export type { KbdKey, KbdNamedKey, KbdPlatform, KbdProps };
