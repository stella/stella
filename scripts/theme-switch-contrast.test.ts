import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { declarationsOf, substitute, toSrgb } from "./generate-mobile-ui-theme";

// A switch says "on" by its track's colour as much as by its thumb's side,
// so each track must stand out from the surfaces a switch sits on: WCAG's
// non-text contrast (1.4.11) asks for 3:1, in every palette and scheme.

const UI_THEME = path.resolve(
  import.meta.dirname,
  "../packages/ui/src/styles/theme.css",
);

const uiCss = await readFile(UI_THEME, "utf-8");
const tailwindCss = await readFile(
  createRequire(UI_THEME).resolve("tailwindcss/theme.css"),
  "utf-8",
);
const tailwindPalette = new Map(
  [
    ...tailwindCss.matchAll(
      /(?<![\w-])(--color-[\w-]+)\s*:\s*([^\s;][^;]*);/gu,
    ),
  ].flatMap(([, name, value]) =>
    name === undefined || value === undefined ? [] : [[name, value.trim()]],
  ),
);

/** Each palette and scheme, its own declarations first. */
const SCHEMES = {
  light: [":root"],
  dark: [".dark", ":root"],
  "flexoki light": [".palette-flexoki", ":root"],
  "flexoki dark": [
    ".palette-flexoki.dark",
    ".palette-flexoki",
    ".dark",
    ":root",
  ],
  "nord light": [".palette-nord", ":root"],
  "nord dark": [".palette-nord.dark", ".palette-nord", ".dark", ":root"],
} as const satisfies Record<string, readonly string[]>;

const colorOf = (selectors: readonly string[], token: string) => {
  const scopes = [
    ...selectors.map((selector) => declarationsOf(uiCss, selector)),
    tailwindPalette,
  ];
  return toSrgb(substitute(`var(${token})`, scopes));
};

const channel = (hex: string, index: number) => {
  const value = Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  const unit = value / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of an opaque `#rrggbb` (or `#rgb`) colour. */
const luminance = (color: string) => {
  const hex =
    color.length === 4
      ? `#${[...color.slice(1)].map((digit) => digit + digit).join("")}`
      : color;
  if (!/^#[\da-f]{6}$/u.test(hex)) {
    throw new Error(`Expected an opaque colour, got ${color}`);
  }
  return (
    0.2126 * channel(hex, 0) +
    0.7152 * channel(hex, 1) +
    0.0722 * channel(hex, 2)
  );
};

const contrast = (a: string, b: string) => {
  const [lighter, darker] = [luminance(a), luminance(b)].toSorted(
    (x, y) => y - x,
  );
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
};

for (const [scheme, selectors] of Object.entries(SCHEMES)) {
  test(`both switch tracks stand 3:1 against the page and cards (${scheme})`, () => {
    for (const track of ["--switch-track", "--switch-track-checked"]) {
      for (const surface of ["--background", "--card", "--popover"]) {
        expect({
          track,
          surface,
          ratio:
            contrast(colorOf(selectors, track), colorOf(selectors, surface)) >=
            3,
        }).toEqual({ track, surface, ratio: true });
      }
    }
  });

  test(`the on and off tracks differ under the white thumb (${scheme})`, () => {
    const thumb = colorOf(selectors, "--switch-thumb");
    expect(thumb).toBe("#fff");
    expect(colorOf(selectors, "--switch-track-checked")).not.toBe(
      colorOf(selectors, "--switch-track"),
    );
  });
}
