// The outcome page a local loopback server answers with: `OutcomeScreen`
// from `@stll/ui/outcome-screen`, rendered once per tone into one
// self-contained HTML document, plus its optional parts (the facts, a
// command) as fragments a listener fills and puts into the page's slots.
//
// The desktop app's and the CLI's sign-in listeners run no React and must not
// load anything (their CSP is `default-src 'none'`, with `img-src data:` for
// the inline favicon), so they cannot draw the component themselves. This
// renders it with `react-dom/server`, compiles exactly the Tailwind utilities
// its markup uses, resolves the theme tokens those utilities read for light
// and dark (the listener's `data-theme`, else `prefers-color-scheme`), and
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
import {
  OutcomeButtonLabel,
  OutcomeCommand,
  OutcomeControl,
  OutcomeDetailList,
  OutcomeDetailRow,
  OutcomeLayout,
  OutcomeNote,
} from "../src/components/outcome-screen-view";
import type { OutcomeTone } from "../src/components/outcome-screen-view";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const UI_THEME = path.join(REPO_ROOT, "packages/ui/src/styles/theme.css");
// The web app's tab icon, so a loopback tab reads as a stella tab.
const FAVICON = path.join(REPO_ROOT, "apps/web/public/favicon.svg");
const HTML_OUTPUT = (name: string) =>
  path.join(REPO_ROOT, `packages/ui/generated/outcome-page.${name}.gen.html`);
const CLI_OUTPUT = path.join(
  REPO_ROOT,
  "packages/cli/src/auth/outcome-page.gen.ts",
);

/**
 * What a listener puts into a page. `theme` is `light`, `dark` or `system`;
 * `details`, `command` and `note` take a filled fragment (below) or nothing;
 * `description` is escaped text, in which a listener may place filled
 * `control` and `buttonLabel` fragments; every other value is escaped text.
 */
export const OUTCOME_PAGE_SLOTS = {
  lang: "{{lang}}",
  dir: "{{dir}}",
  theme: "{{theme}}",
  title: "{{title}}",
  description: "{{description}}",
  details: "{{details}}",
  command: "{{command}}",
  note: "{{note}}",
} as const;

/** The slots inside the fragments; `rows` takes filled `detailRow`s. */
export const OUTCOME_FRAGMENT_SLOTS = {
  rows: "{{rows}}",
  label: "{{label}}",
  value: "{{value}}",
  code: "{{code}}",
  text: "{{text}}",
} as const;

/** The web app's page-title suffix (apps/web/src/lib/page-title.ts). */
const TITLE_SUFFIX = " | stella";

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
      loadStylesheet: async (id, base) => {
        if (id !== "tailwindcss/theme.css") {
          return panic(`The outcome page imports an unexpected sheet: ${id}`);
        }
        return {
          path: tailwindThemePath,
          base,
          content: await readFile(tailwindThemePath, "utf-8"),
        };
      },
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
  // A listener that knows the app's scheme names it in `data-theme`; `system`
  // follows the browser's.
  return [
    `:root{${scheme(light)}}`,
    ":root[data-theme=light]{color-scheme:light}",
    `:root[data-theme=dark]{color-scheme:dark;${scheme(dark)}}`,
    `@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${scheme(dark)}}}`,
    BASE_CSS,
    utilities,
  ].join("\n");
};

// One line per element in the source; joined, it is a compact data URI.
const faviconHref = (svg: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    svg
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" "),
  )}`;

const renderOutcomeMarkup = (tone: OutcomeTone, css: string, favicon: string) =>
  `<!doctype html>${renderToStaticMarkup(
    createElement(
      "html",
      {
        "data-theme": OUTCOME_PAGE_SLOTS.theme,
        dir: OUTCOME_PAGE_SLOTS.dir,
        lang: OUTCOME_PAGE_SLOTS.lang,
      },
      createElement(
        "head",
        null,
        createElement("meta", { charSet: "utf-8" }),
        createElement("meta", {
          content: "width=device-width, initial-scale=1",
          name: "viewport",
        }),
        createElement("meta", { content: "light dark", name: "color-scheme" }),
        createElement("link", {
          href: favicon,
          rel: "icon",
          type: "image/svg+xml",
        }),
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
        createElement(OutcomeLayout, {
          command: OUTCOME_PAGE_SLOTS.command,
          description: OUTCOME_PAGE_SLOTS.description,
          details: OUTCOME_PAGE_SLOTS.details,
          documentTitle: `${OUTCOME_PAGE_SLOTS.title}${TITLE_SUFFIX}`,
          note: OUTCOME_PAGE_SLOTS.note,
          title: OUTCOME_PAGE_SLOTS.title,
          tone,
        }),
      ),
    ),
  )}\n`;

/** The optional parts, each filled by a listener and put into its slot. */
const renderFragments = () => ({
  details: renderToStaticMarkup(
    createElement(OutcomeDetailList, null, OUTCOME_FRAGMENT_SLOTS.rows),
  ),
  detailRow: renderToStaticMarkup(
    createElement(OutcomeDetailRow, {
      label: OUTCOME_FRAGMENT_SLOTS.label,
      value: OUTCOME_FRAGMENT_SLOTS.value,
    }),
  ),
  command: renderToStaticMarkup(
    createElement(OutcomeCommand, null, OUTCOME_FRAGMENT_SLOTS.code),
  ),
  note: renderToStaticMarkup(
    createElement(OutcomeNote, null, OUTCOME_FRAGMENT_SLOTS.text),
  ),
  control: renderToStaticMarkup(
    createElement(OutcomeControl, null, OUTCOME_FRAGMENT_SLOTS.text),
  ),
  buttonLabel: renderToStaticMarkup(
    createElement(OutcomeButtonLabel, null, OUTCOME_FRAGMENT_SLOTS.text),
  ),
});

export const outcomePageArtifacts = async (): Promise<GeneratedArtifact[]> => {
  const uiCss = await readFile(UI_THEME, "utf-8");
  const favicon = faviconHref(await readFile(FAVICON, "utf-8"));
  const tailwindThemePath = createRequire(UI_THEME).resolve(
    "tailwindcss/theme.css",
  );
  const fragments = renderFragments();
  // The stylesheet covers both tones and every fragment, so the two pages
  // share one CSP hash.
  const css = await outcomePageCss(
    [
      ...TONES.map((tone) => renderOutcomeMarkup(tone, "", favicon)),
      ...Object.values(fragments),
    ],
    uiCss,
    tailwindThemePath,
  );
  const pages = {
    success: renderOutcomeMarkup("success", css, favicon),
    error: renderOutcomeMarkup("error", css, favicon),
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
    // The desktop's listener fills in facts and the note; it never shows a
    // command.
    { path: HTML_OUTPUT("details"), contents: `${fragments.details}\n` },
    { path: HTML_OUTPUT("detail-row"), contents: `${fragments.detailRow}\n` },
    { path: HTML_OUTPUT("note"), contents: `${fragments.note}\n` },
    // Its retry steps name the app's own controls inside the description.
    { path: HTML_OUTPUT("control"), contents: `${fragments.control}\n` },
    {
      path: HTML_OUTPUT("button-label"),
      contents: `${fragments.buttonLabel}\n`,
    },
    {
      path: CLI_OUTPUT,
      contents: [
        "// Generated by packages/ui/scripts/generate-outcome-page.ts from",
        "// packages/ui/src/components/outcome-screen-view.tsx. Do not edit; run",
        "// it with --write.",
        "",
        `export const OUTCOME_PAGE_SLOTS = ${JSON.stringify(OUTCOME_PAGE_SLOTS)} as const;`,
        "",
        `export const OUTCOME_FRAGMENT_SLOTS = ${JSON.stringify(OUTCOME_FRAGMENT_SLOTS)} as const;`,
        "",
        "export const OUTCOME_PAGE_TEMPLATES = {",
        ...TONES.map((tone) => `  ${tone}: ${JSON.stringify(pages[tone])},`),
        "} as const;",
        "",
        "export const OUTCOME_PAGE_FRAGMENTS = {",
        ...Object.entries(fragments).map(
          ([name, markup]) => `  ${name}: ${JSON.stringify(markup)},`,
        ),
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
