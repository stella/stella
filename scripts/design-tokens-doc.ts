// Renders DESIGN.md's semantic token table and font stack from
// packages/ui/src/styles/theme.css, the design system's source of truth, so
// the documented values cannot drift from what ships.
//
//   bun scripts/design-tokens-doc.ts --check   fail when DESIGN.md is stale
//   bun scripts/design-tokens-doc.ts --write   regenerate the marked sections

import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const THEME_PATH = "packages/ui/src/styles/theme.css";
const DOC_PATH = "DESIGN.md";

const TOKEN_MARKERS = {
  begin: "<!-- BEGIN GENERATED DESIGN TOKENS -->",
  end: "<!-- END GENERATED DESIGN TOKENS -->",
} as const;

const FONT_MARKERS = {
  begin: "<!-- BEGIN GENERATED FONT STACK -->",
  end: "<!-- END GENERATED FONT STACK -->",
} as const;

// The documented tokens, in table order, with the role each one plays. The
// values come from theme.css; only the roles are authored here.
const TOKEN_ROLES = [
  ["--background", "Page canvas"],
  ["--foreground", "Primary text"],
  ["--card", "Card surfaces"],
  ["--card-foreground", "Text on cards"],
  ["--primary", "Primary actions, headings"],
  ["--primary-foreground", "Text on primary"],
  ["--secondary", "Secondary surfaces"],
  ["--muted", "Subdued backgrounds"],
  ["--muted-foreground", "Secondary text"],
  ["--accent", "Hover/focus highlights"],
  ["--destructive", "Destructive actions"],
  ["--info", "Informational status"],
  ["--success", "Success status"],
  ["--warning", "Warning status"],
  ["--highlight", "Search/text highlight"],
  ["--border", "Borders, dividers"],
  ["--input", "Input borders"],
  ["--ring", "Focus rings"],
] as const;

const DECLARATION = /^[ \t]*(--[\w-]+):\s*([^;\s][^;]*);/gmu;

// Declarations of the first top-level block opened by `selector {`.
const readBlock = (css: string, selector: string): Map<string, string> => {
  const open = css.indexOf(`\n${selector} {`);
  if (open === -1) {
    panic(`${THEME_PATH} has no \`${selector}\` block`);
  }
  const close = css.indexOf("\n}", open);
  const body = css.slice(open, close);
  const declarations = new Map<string, string>();
  for (const match of body.matchAll(DECLARATION)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) {
      // Collapse the formatter's multi-line wrapping to one-line CSS.
      const oneLine = value
        .replaceAll(/\s+/gu, " ")
        .replaceAll("( ", "(")
        .replaceAll(" )", ")")
        .trim();
      declarations.set(name, oneLine);
    }
  }
  return declarations;
};

const COLOR_VARIABLE = /^var\(--(?:color-)?([\w-]+)\)$/u;
const ALPHA = /^--alpha\((\S+) \/ (\d+%)\)$/u;
const COLOR_MIX = /^color-mix\(in srgb, (\S+) (\d+%), (\S+)\)$/u;

// Tailwind-palette shorthand for a token value: `var(--color-neutral-800)` is
// `neutral-800`, `--alpha(black / 4%)` is `black / 4%`, and a
// `color-mix(in srgb, a 90%, b)` is `a / 90% b blend`. A shape this does not
// know fails the generator rather than documenting raw CSS.
const describeValue = (value: string): string => {
  const variable = COLOR_VARIABLE.exec(value);
  if (variable?.[1] !== undefined) {
    return variable[1];
  }
  const alpha = ALPHA.exec(value);
  if (alpha?.[1] !== undefined && alpha[2] !== undefined) {
    return `${describeValue(alpha[1])} / ${alpha[2]}`;
  }
  const mix = COLOR_MIX.exec(value);
  if (mix?.[1] !== undefined && mix[2] !== undefined && mix[3] !== undefined) {
    return `${describeValue(mix[1])} / ${mix[2]} ${describeValue(mix[3])} blend`;
  }
  return panic(`${THEME_PATH}: cannot describe token value \`${value}\``);
};

const renderTable = (rows: readonly (readonly string[])[]): string[] => {
  const widths = rows
    .at(0)
    ?.map((_, column) =>
      Math.max(...rows.map((row) => (row[column] ?? "").length)),
    );
  if (widths === undefined) {
    return panic("design token table has no header row");
  }
  const line = (cells: readonly string[]) =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(" | ")} |`;
  const [header, ...body] = rows;
  return [
    line(header ?? []),
    line(widths.map((width) => "-".repeat(width))),
    ...body.map(line),
  ];
};

const renderTokens = (css: string): string => {
  const light = readBlock(css, ":root");
  const dark = readBlock(css, ".dark");
  const valueOf = (block: Map<string, string>, token: string) =>
    describeValue(
      block.get(token) ?? panic(`${THEME_PATH} does not define ${token}`),
    );
  const rows = TOKEN_ROLES.map(([token, role]) => [
    `\`${token}\``,
    valueOf(light, token),
    valueOf(dark, token),
    role,
  ]);
  return [
    TOKEN_MARKERS.begin,
    "",
    ...renderTable([["Token", "Light", "Dark", "Role"], ...rows]),
    "",
    TOKEN_MARKERS.end,
  ].join("\n");
};

const FONT_SANS = /--font-sans:\s*([^;\s][^;]*);/u;

const renderFontStack = (css: string): string => {
  const stack =
    FONT_SANS.exec(css)?.[1] ?? panic(`${THEME_PATH} has no --font-sans`);
  return [
    FONT_MARKERS.begin,
    "",
    "```",
    ...stack
      .trim()
      .split("\n")
      .map((line) => line.trim()),
    "```",
    "",
    FONT_MARKERS.end,
  ].join("\n");
};

const replaceSection = (
  doc: string,
  markers: { readonly begin: string; readonly end: string },
  rendered: string,
): string => {
  const start = doc.indexOf(markers.begin);
  const end = doc.indexOf(markers.end);
  if (start === -1 || end < start) {
    panic(`${DOC_PATH} is missing the ${markers.begin} section`);
  }
  return doc.slice(0, start) + rendered + doc.slice(end + markers.end.length);
};

const renderDesignDoc = (doc: string, css: string): string =>
  replaceSection(
    replaceSection(doc, TOKEN_MARKERS, renderTokens(css)),
    FONT_MARKERS,
    renderFontStack(css),
  );

const main = (argv: readonly string[]): number => {
  const docFile = path.join(REPO_ROOT, DOC_PATH);
  const committed = readFileSync(docFile, "utf-8");
  const rendered = renderDesignDoc(
    committed,
    readFileSync(path.join(REPO_ROOT, THEME_PATH), "utf-8"),
  );

  if (argv.includes("--write")) {
    writeFileSync(docFile, rendered);
    console.log(`design-tokens-doc: wrote ${DOC_PATH}.`);
    return 0;
  }
  if (!argv.includes("--check")) {
    console.error("Usage: bun scripts/design-tokens-doc.ts --check | --write");
    return 1;
  }
  if (committed !== rendered) {
    console.error(
      `${DOC_PATH} does not match ${THEME_PATH}; regenerate with \`bun scripts/design-tokens-doc.ts --write\``,
    );
    return 1;
  }
  console.log(`design-tokens-doc: OK (${DOC_PATH} matches ${THEME_PATH}).`);
  return 0;
};

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
