import { expect, test } from "bun:test";

import {
  declarationsOf,
  mobileUiTheme,
  optionColorsOf,
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

test("carries the option tags' colour pairs, not their swatches", () => {
  const scope = declarationsOf(
    `:root {
  --option-red: #f00;
  --option-red-bg: color-mix(in srgb, var(--option-red) 12%, #fff);
  --option-red-fg: var(--option-red);
}`,
    ":root",
  );
  expect(optionColorsOf(scope)).toEqual(
    new Map([
      ["option-red-bg", "--option-red-bg"],
      ["option-red-fg", "--option-red-fg"],
    ]),
  );
});
