// The outcome page a local loopback server answers with: `OutcomeScreen`
// from `@stll/ui/outcome-screen`, rendered once per tone into one
// self-contained HTML document.
//
// The desktop app's and the CLI's sign-in listeners run no React and must not
// load anything (their CSP is `default-src 'none'`), so they cannot draw the
// component themselves. This renders it with `react-dom/server`, compiles
// exactly the Tailwind utilities its markup uses, resolves the theme tokens
// those utilities read for light and dark (`prefers-color-scheme`), and
// inlines it all into one `<style>`. The listeners fill the slots below with
// escaped text; a change to the component or the theme fails the
// generated-files check until the template takes it too.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { panic } from "better-result";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { compile } from "tailwindcss";

import {
  declarationsOf,
  substitute,
} from "../../../scripts/generate-mobile-ui-theme";
import { writeOrCheckArtifacts } from "../../../scripts/generated-artifacts";
import type { GeneratedArtifact } from "../../scripts/src/generated-artifact-format.ts";
import { OutcomeScreenView } from "../src/components/outcome-screen-view";
import type { OutcomeTone } from "../src/components/outcome-screen-view";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const UI_THEME = path.join(REPO_ROOT, "packages/ui/src/styles/theme.css");
const HTML_OUTPUT = (tone: OutcomeTone) =>
  path.join(REPO_ROOT, `packages/ui/generated/outcome-page.${tone}.gen.html`);
const CLI_OUTPUT = path.join(
  REPO_ROOT,
  "packages/cli/src/auth/outcome-page.gen.ts",
);

/** The text a listener puts into the template, every value escaped first. */
export const OUTCOME_PAGE_SLOTS = {
  lang: "{{lang}}",
  dir: "{{dir}}",
  title: "{{title}}",
  description: "{{description}}",
  note: "{{note}}",
} as const;

const TONES = ["success", "error"] as const satisfies readonly OutcomeTone[];

// The page scaffold a stylesheet-less document needs: what the web app's base
// layer gives every page.
const BASE_CSS = `
*,::before,::after{box-sizing:border-box;margin:0;padding:0;border:0 solid}
html{color-scheme:light dark;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;line-height:1.5;-webkit-text-size-adjust:100%}
body{background:var(--background);color:var(--foreground)}
svg{display:block}
`;

/** The theme's `@theme inline { … }` block, which maps utilities to tokens. */
const themeInlineBlock = (uiCss: string): string => {
  const start = uiCss.indexOf("@theme inline {");
  const end = uiCss.indexOf("\n}", start);
  if (start === -1 || end === -1) {
    return panic("packages/ui theme.css has no `@theme inline` block");
  }
  const block = uiCss.slice(start, end + 2);
  // The app's typeface is not on a loopback page; Tailwind's default system
  // stack stands in for it.
  const font = block.indexOf("--font-sans:");
  const fontEnd = block.indexOf(";", font);
  if (font === -1 || fontEnd === -1) {
    return panic("packages/ui theme.css no longer names `--font-sans`");
  }
  return block.slice(0, font) + block.slice(fontEnd + 1);
};

const classesOf = (markup: string): string[] => [
  ...new Set(
    [...markup.matchAll(/\sclass="([^"]*)"/gu)].flatMap(([, value]) =>
      (value ?? "").split(/\s+/u).filter(Boolean),
    ),
  ),
];

/** Every custom property `css` reads but does not declare. */
const unresolvedVariables = (css: string): string[] => {
  const declared = new Set(
    [...css.matchAll(/(?<![\w-])(--[\w-]+)\s*:/gu)].map(([, name]) => name),
  );
  return [
    ...new Set(
      [...css.matchAll(/var\((--[\w-]+)/gu)]
        .map(([, name]) => name)
        .filter((name): name is string => name !== undefined),
    ),
  ]
    .filter((name) => !declared.has(name))
    .toSorted();
};

/** The utilities `markup` uses, with the theme tokens they read. */
export const outcomePageCss = async (
  markups: readonly string[],
  uiCss: string,
  tailwindThemePath: string,
): Promise<string> => {
  const tailwindTheme = await readFile(tailwindThemePath, "utf-8");
  const compiler = await compile(
    [
      '@import "tailwindcss/theme.css" layer(theme);',
      "@tailwind utilities;",
      themeInlineBlock(uiCss),
    ].join("\n"),
    {
      base: REPO_ROOT,
      loadStylesheet: (id, base) =>
        id === "tailwindcss/theme.css"
          ? Promise.resolve({
              path: tailwindThemePath,
              base,
              content: tailwindTheme,
            })
          : panic(`The outcome page imports an unexpected sheet: ${id}`),
    },
  );
  const utilities = compiler.build(markups.flatMap(classesOf));
  // Tailwind declares its palette once, in its `@theme default` block.
  const palette = new Map(
    [
      ...tailwindTheme.matchAll(/(?<![\w-])(--[\w-]+)\s*:\s*([^\s;][^;]*);/gu),
    ].flatMap(([, name, value]) =>
      name === undefined || value === undefined ? [] : [[name, value.trim()]],
    ),
  );
  const light = declarationsOf(uiCss, ":root");
  const dark = new Map([...light, ...declarationsOf(uiCss, ".dark")]);
  const tokens = unresolvedVariables(BASE_CSS + utilities).filter(
    (name) => !name.startsWith("--tw-"),
  );
  const scheme = (scope: ReadonlyMap<string, string>) =>
    tokens
      .map((name) => `${name}:${substitute(`var(${name})`, [scope, palette])}`)
      .join(";");
  return [
    `:root{${scheme(light)}}`,
    `@media (prefers-color-scheme:dark){:root{${scheme(dark)}}}`,
    BASE_CSS,
    utilities,
  ].join("\n");
};

const renderOutcomeMarkup = (tone: OutcomeTone, css: string) =>
  `<!doctype html>${renderToStaticMarkup(
    createElement(
      "html",
      { dir: OUTCOME_PAGE_SLOTS.dir, lang: OUTCOME_PAGE_SLOTS.lang },
      createElement(
        "head",
        null,
        createElement("meta", { charSet: "utf-8" }),
        createElement("meta", {
          content: "width=device-width, initial-scale=1",
          name: "viewport",
        }),
        createElement("meta", { content: "light dark", name: "color-scheme" }),
        createElement("style", {
          dangerouslySetInnerHTML: {
            // safe-html: Tailwind output compiled from the committed theme and component; no request or user text reaches it.
            __html: css,
          },
        }),
      ),
      createElement(
        "body",
        null,
        createElement(OutcomeScreenView, {
          description: OUTCOME_PAGE_SLOTS.description,
          note: OUTCOME_PAGE_SLOTS.note,
          title: OUTCOME_PAGE_SLOTS.title,
          tone,
        }),
      ),
    ),
  )}\n`;

export const outcomePageArtifacts = async (): Promise<GeneratedArtifact[]> => {
  const uiCss = await readFile(UI_THEME, "utf-8");
  const tailwindThemePath = createRequire(UI_THEME).resolve(
    "tailwindcss/theme.css",
  );
  // The stylesheet covers both tones, so the two pages share one CSP hash.
  const css = await outcomePageCss(
    TONES.map((tone) => renderOutcomeMarkup(tone, "")),
    uiCss,
    tailwindThemePath,
  );
  const pages = {
    success: renderOutcomeMarkup("success", css),
    error: renderOutcomeMarkup("error", css),
  } satisfies Record<OutcomeTone, string>;
  for (const page of Object.values(pages)) {
    for (const slot of Object.values(OUTCOME_PAGE_SLOTS)) {
      if (!page.includes(slot)) {
        return panic(`The outcome page lost its ${slot} slot`);
      }
    }
  }
  return [
    ...TONES.map((tone) => ({
      path: HTML_OUTPUT(tone),
      contents: pages[tone],
    })),
    {
      path: CLI_OUTPUT,
      contents: [
        "// Generated by packages/ui/scripts/generate-outcome-page.ts from",
        "// packages/ui/src/components/outcome-screen-view.tsx. Do not edit; run",
        "// it with --write.",
        "",
        `export const OUTCOME_PAGE_SLOTS = ${JSON.stringify(OUTCOME_PAGE_SLOTS)} as const;`,
        "",
        "export const OUTCOME_PAGE_TEMPLATES = {",
        ...TONES.map((tone) => `  ${tone}: ${JSON.stringify(pages[tone])},`),
        "} as const;",
        "",
      ].join("\n"),
    },
  ];
};

if (import.meta.main) {
  process.exitCode = await writeOrCheckArtifacts(await outcomePageArtifacts(), {
    matched: "packages/ui/src/components/outcome-screen-view.tsx",
    write: process.argv.includes("--write"),
  });
}
