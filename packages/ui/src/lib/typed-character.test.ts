import { describe, expect, test } from "bun:test";

import { typedCharacter } from "./typed-character";

type LayoutRow = {
  layout: string;
  key: string;
  altKey?: boolean;
  altGraph?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  metaKey?: boolean;
  expected: string | null;
};

// Field sets browsers report for real presses on each layout. Shift is folded
// into `key` everywhere, so the rows leave it out.
const LAYOUT_ROWS: readonly LayoutRow[] = [
  { layout: "US Shift+2", key: "@", expected: "@" },
  { layout: "Czech macOS Option+2", key: "@", altKey: true, expected: "@" },
  { layout: "German macOS Option+L", key: "@", altKey: true, expected: "@" },
  { layout: "Slovak macOS Option+7", key: "&", altKey: true, expected: "&" },
  {
    layout: "Slovak macOS Option+Shift+8",
    key: "{",
    altKey: true,
    expected: "{",
  },
  {
    layout: "Czech Windows AltGr+V",
    key: "@",
    altKey: true,
    ctrlKey: true,
    altGraph: true,
    expected: "@",
  },
  {
    layout: "Polish Windows AltGr+A",
    key: "ą",
    altKey: true,
    ctrlKey: true,
    altGraph: true,
    expected: "ą",
  },
  {
    layout: "Windows Ctrl+Alt without the AltGraph state",
    key: "@",
    altKey: true,
    ctrlKey: true,
    expected: "@",
  },
  {
    layout: "French AZERTY AltGr+0",
    key: "@",
    altKey: true,
    ctrlKey: true,
    altGraph: true,
    expected: "@",
  },
  { layout: "macOS Cmd+A", key: "a", metaKey: true, expected: null },
  { layout: "Ctrl+A", key: "a", ctrlKey: true, expected: null },
  {
    layout: "US Ctrl+Shift+2",
    key: "@",
    ctrlKey: true,
    expected: null,
  },
  { layout: "IME composition", key: "k", isComposing: true, expected: null },
  { layout: "Enter", key: "Enter", expected: null },
  { layout: "dead key", key: "Dead", altKey: true, expected: null },
  { layout: "ArrowLeft", key: "ArrowLeft", expected: null },
  { layout: "astral emoji", key: "😀", expected: "😀" },
  { layout: "flag (two code points)", key: "🇨🇿", expected: "🇨🇿" },
];

describe("typed characters across keyboard layouts", () => {
  test.each(LAYOUT_ROWS)(
    "$layout",
    ({
      altGraph = false,
      altKey = false,
      ctrlKey = false,
      expected,
      isComposing = false,
      key,
      metaKey = false,
    }) => {
      expect(
        typedCharacter({
          altKey,
          ctrlKey,
          getModifierState: (modifier) => modifier === "AltGraph" && altGraph,
          isComposing,
          key,
          metaKey,
        }),
      ).toBe(expected);
    },
  );
});
