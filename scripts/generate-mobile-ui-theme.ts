// The mobile app's colours, from the same tokens the web uses.
//
// React Native cannot read `packages/ui/src/styles/theme.css`: its colours
// are `var()` chains into Tailwind's oklch palette, `color-mix()` and
// Tailwind's `--alpha()`. This resolves every semantic colour the web theme
// exposes (`@theme inline { --color-card: var(--card) }`) for light and dark
// into plain sRGB, so the app shows exactly the web's colours and a change to
// the web theme fails the generated-files check until the app takes it too.

import { panic } from "better-result";
import { transform } from "lightningcss";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { writeOrCheckArtifacts } from "./generated-artifacts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const UI_THEME = path.join(REPO_ROOT, "packages/ui/src/styles/theme.css");
const OUTPUT = path.join(REPO_ROOT, "apps/mobile/src/ui-theme.gen.ts");
const CSS_OUTPUT = path.join(REPO_ROOT, "apps/mobile/ui-theme.gen.css");

type Scope = ReadonlyMap<string, string>;

/** Custom properties declared in the blocks whose selector is exactly `selector`. */
export const declarationsOf = (css: string, selector: string): Scope => {
  const found = new Map<string, string>();
  for (const block of css.split(/\n(?=[^\s{}][^{}]*\{)/u)) {
    if (block.slice(0, block.indexOf("{")).trim() !== selector) {
      continue;
    }
    for (const [, name, value] of block.matchAll(
      /(?<![\w-])(--[\w-]+)\s*:\s*([^\s;][^;]*);/gu,
    )) {
      if (name !== undefined && value !== undefined) {
        found.set(name, value.replaceAll(/\s+/gu, " ").trim());
      }
    }
  }
  return found;
};

/** The semantic colours the web theme exposes, as `--color-x` to `--x`. */
export const semanticColorsOf = (css: string): Map<string, string> => {
  const start = css.indexOf("@theme inline {");
  const block = css.slice(start, css.indexOf("\n}", start));
  const colors = new Map<string, string>();
  for (const [, name, source] of block.matchAll(
    /--color-([\w-]+)\s*:\s*var\((--[\w-]+)\)\s*;/gu,
  )) {
    if (name !== undefined && source !== undefined) {
      colors.set(name, source);
    }
  }
  return colors;
};

/**
 * The option palette (`--option-blue`, `--option-blue-bg`, ...), which paints
 * a matter's colour, tags and other user-chosen tints. The web reads it
 * directly rather than through `@theme`, so it comes along as `option-blue`.
 */
export const optionColorsOf = (scope: Scope): Map<string, string> =>
  new Map(
    [...scope.keys()]
      .filter((name) => name.startsWith("--option-"))
      .map((name) => [name.slice(2), name]),
  );

/**
 * `value` with every `var()` replaced by its definition and Tailwind's
 * `--alpha(color / n%)` spelled as the `color-mix()` Tailwind emits for it.
 */
export const substitute = (
  value: string,
  scopes: readonly Scope[],
  depth = 0,
): string => {
  if (depth > 32) {
    return panic(`Theme variables reference each other: ${value}`);
  }
  const expanded = value.replaceAll(
    /var\((--[\w-]+)\)/gu,
    (_var, name: string) => {
      const definition = scopes
        .map((scope) => scope.get(name))
        .find((candidate) => candidate !== undefined);
      if (definition === undefined) {
        return panic(`The theme uses ${name}, which nothing defines`);
      }
      return substitute(definition, scopes, depth + 1);
    },
  );
  // Tailwind's `--alpha(color / n%)`, read once its colour is spelled out.
  return expanded.replaceAll(
    /(?<![\w-])--alpha\(((?:[^/()]|\([^()]*\))*)\/\s*([\d.]+%)\s*\)/gu,
    (_alpha, color: string, amount: string) =>
      `color-mix(in oklab, ${color.trim()} ${amount}, transparent)`,
  );
};

/** A static CSS colour as sRGB hex, the form React Native reads. */
export const toSrgb = (color: string): string => {
  const { code } = transform({
    filename: "theme.css",
    code: Buffer.from(`a{color:${color}}`),
    minify: true,
    // Safari 10 (lightningcss encodes a version as major << 16): old enough
    // that oklch, lab and color-mix() all lower to sRGB.
    targets: { safari: 655_360 },
  });
  const lowered = /^a\{color:(#[\da-f]+)[;}]/u.exec(code.toString())?.[1];
  if (lowered === undefined) {
    return panic(`Could not lower ${color} to sRGB: ${code.toString()}`);
  }
  return lowered;
};

const camelCase = (name: string) =>
  name.replaceAll(/-(\w)/gu, (_dash, letter: string) => letter.toUpperCase());

export const mobileUiTheme = (uiCss: string, tailwindCss: string) => {
  // Tailwind declares its palette once, inside `@layer theme`.
  const palette = new Map(
    [
      ...tailwindCss.matchAll(
        /(?<![\w-])(--color-[\w-]+)\s*:\s*([^\s;][^;]*);/gu,
      ),
    ].flatMap(([, name, value]) =>
      name === undefined || value === undefined ? [] : [[name, value.trim()]],
    ),
  );
  const light = declarationsOf(uiCss, ":root");
  const dark = new Map([...light, ...declarationsOf(uiCss, ".dark")]);
  const colorsFor = (scope: Scope) =>
    Object.fromEntries(
      [...semanticColorsOf(uiCss), ...optionColorsOf(light)].map(
        ([name, source]) => [
          name,
          toSrgb(substitute(`var(${source})`, [scope, palette])),
        ],
      ),
    );
  return { light: colorsFor(light), dark: colorsFor(dark) };
};

/** Laid out as the repository's formatter would, so formatting never drifts it. */
export const renderMobileUiTheme = (
  theme: ReturnType<typeof mobileUiTheme>,
): string => {
  const scheme = (name: string, colors: Record<string, string>) => [
    `  ${name}: {`,
    ...Object.keys(colors)
      .toSorted()
      .map((key) => `    ${camelCase(key)}: ${JSON.stringify(colors[key])},`),
    "  },",
  ];
  return [
    "// Generated by scripts/generate-mobile-ui-theme.ts from",
    "// packages/ui/src/styles/theme.css. Do not edit; run it with --write.",
    "",
    "export const UI_COLORS = {",
    ...scheme("light", theme.light),
    ...scheme("dark", theme.dark),
    "} as const;",
    "",
    "export type UiColors = (typeof UI_COLORS)[keyof typeof UI_COLORS];",
    "",
  ].join("\n");
};

/** The type sizes the web adds to Tailwind's scale (`text-2xs`, ...). */
export const extraTextSizesOf = (css: string): string[] => {
  const start = css.indexOf("@theme inline {");
  const block = css.slice(start, css.indexOf("\n}", start));
  return [...block.matchAll(/(--text-[\w-]+)\s*:\s*([^;]+);/gu)].flatMap(
    ([, name, value]) =>
      name === undefined || value === undefined
        ? []
        : [`${name}: ${value.trim()};`],
  );
};

/**
 * The same tokens for uniwind, the app's Tailwind: each web colour under its
 * web name (`bg-card`, `text-muted-foreground`), switched by colour scheme,
 * and the web's extra type sizes.
 */
export const renderMobileUiThemeCss = (
  theme: ReturnType<typeof mobileUiTheme>,
  textSizes: readonly string[],
): string => {
  const scheme = (name: string, colors: Record<string, string>) => [
    `    @variant ${name} {`,
    ...Object.keys(colors)
      .toSorted()
      .map((key) => `      --color-${key}: ${colors[key] ?? ""};`),
    "    }",
  ];
  return [
    "/* Generated by scripts/generate-mobile-ui-theme.ts from",
    "   packages/ui/src/styles/theme.css. Do not edit; run it with --write. */",
    "@theme {",
    ...textSizes.map((size) => `  ${size}`),
    "}",
    "",
    "@layer theme {",
    "  :root {",
    ...scheme("light", theme.light),
    ...scheme("dark", theme.dark),
    "  }",
    "}",
    "",
  ].join("\n");
};

export const generateMobileUiTheme = async (write: boolean) => {
  const tailwindTheme = createRequire(UI_THEME).resolve(
    "tailwindcss/theme.css",
  );
  const uiCss = await readFile(UI_THEME, "utf-8");
  const theme = mobileUiTheme(uiCss, await readFile(tailwindTheme, "utf-8"));
  return await writeOrCheckArtifacts(
    [
      { path: OUTPUT, contents: renderMobileUiTheme(theme) },
      {
        path: CSS_OUTPUT,
        contents: renderMobileUiThemeCss(theme, extraTextSizesOf(uiCss)),
      },
    ],
    { matched: "the web theme's colours", write },
  );
};

if (import.meta.main) {
  process.exitCode = await generateMobileUiTheme(
    process.argv.includes("--write"),
  );
}
