import { expect, test } from "bun:test";

import {
  additionalColorsOf,
  declarationsOf,
  mobileUiTheme,
  semanticColorsOf,
  substitute,
  toSrgb,
} from "./generate-mobile-ui-theme";

const PALETTE = `@layer theme {
  :root, :host {
    --color-black: #000;
    --color-white: #fff;
    --color-neutral-800: oklch(26.9% 0 0);
  }
}`;

const UI = `@theme inline {
  --color-background: var(--background);
  --color-border: var(--border);
}

:root {
  --background: var(--color-white);
  --border: --alpha(var(--color-black) / 10%);
}

.dark {
  --background: var(--color-neutral-800);
}
`;

test("reads the custom properties of an exact selector", () => {
  expect([...declarationsOf(UI, ".dark")]).toEqual([
    ["--background", "var(--color-neutral-800)"],
  ]);
});

test("reads the semantic colours the web theme exposes", () => {
  expect([...semanticColorsOf(UI)]).toEqual([
    ["background", "--background"],
    ["border", "--border"],
  ]);
});

test("spells Tailwind's --alpha() as the color-mix() it compiles to", () => {
  expect(
    substitute("--alpha(var(--x) / 4%)", [new Map([["--x", "#000"]])]),
  ).toBe("color-mix(in oklab, #000 4%, transparent)");
});

test("refuses a variable nothing defines", () => {
  expect(() => substitute("var(--missing)", [new Map()])).toThrow("--missing");
});

test("lowers oklch and color-mix() to sRGB hex", () => {
  expect(toSrgb("oklch(26.9% 0 0)")).toBe("#262626");
  expect(toSrgb("color-mix(in oklab, #000 10%, transparent)")).toBe(
    "#0000001a",
  );
});

test("dark mode overrides light, and both fall back to the palette", () => {
  expect(mobileUiTheme(UI, PALETTE)).toEqual({
    light: { background: "#fff", border: "#0000001a" },
    dark: { background: "#262626", border: "#0000001a" },
  });
});

test("carries the option palette under its web names", () => {
  const scope = declarationsOf(
    `:root {
  --background: #fff;
  --option-red: #f00;
  --option-red-bg: color-mix(in srgb, var(--option-red) 12%, #fff);
}`,
    ":root",
  );
  expect(additionalColorsOf(scope)).toEqual(
    new Map([
      ["option-red", "--option-red"],
      ["option-red-bg", "--option-red-bg"],
    ]),
  );
});

test("carries the sign-in backdrop in both schemes without adding web utility colours", () => {
  // theme.css declares the backdrop in its own trailing :root and .dark
  // blocks, after the main ones and before a utility with a dark variant.
  const css = `${UI}
/* Screen accents, the same in every palette. */
:root {
  --auth-gradient-end: #cbe1fc;
}

.dark {
  --auth-gradient-end: #1a3a5c;
}

@utility category-tile {
  background-color: oklch(0.94 0.045 var(--cat-hue));

  @variant dark {
    background-color: oklch(0.32 0.05 var(--cat-hue));
  }
}
`;
  expect(mobileUiTheme(css, PALETTE)).toMatchObject({
    light: { background: "#fff", "auth-gradient-end": "#cbe1fc" },
    dark: { background: "#262626", "auth-gradient-end": "#1a3a5c" },
  });
  expect(semanticColorsOf(css).has("auth-gradient-end")).toBe(false);
});
