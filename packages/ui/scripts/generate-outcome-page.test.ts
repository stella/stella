import { expect, test } from "bun:test";

import {
  OUTCOME_FRAGMENT_SLOTS,
  OUTCOME_PAGE_SLOTS,
  outcomePageArtifacts,
} from "./generate-outcome-page";

const artifacts = await outcomePageArtifacts();
const pages = artifacts.filter(({ path }) =>
  /outcome-page\.(?:success|error)\.gen\.html$/u.test(path),
);
const fragments = artifacts.filter(({ path }) =>
  /outcome-page\.(?:details|detail-row|note|control|button-label)\.gen\.html$/u.test(
    path,
  ),
);

const styleOf = (page: string) =>
  /<style>([\s\S]*)<\/style>/u.exec(page)?.[1] ?? "";

const unescapeClass = (selector: string) => selector.replaceAll("\\", "");

test("renders one self-contained page per tone, and the facts as fragments", () => {
  expect(
    artifacts
      .map(({ path }) => path.replace(/^.*\//u, ""))
      .filter((name) => name.endsWith(".html"))
      .toSorted(),
  ).toEqual([
    "outcome-page.button-label.gen.html",
    "outcome-page.control.gen.html",
    "outcome-page.detail-row.gen.html",
    "outcome-page.details.gen.html",
    "outcome-page.error.gen.html",
    "outcome-page.note.gen.html",
    "outcome-page.success.gen.html",
  ]);
  for (const { contents } of pages) {
    expect(contents.startsWith("<!doctype html>")).toBe(true);
    // Loads nothing: the listeners' CSP is `default-src 'none'`, with
    // `img-src data:` for the one inline icon.
    expect(contents).not.toMatch(/<script|\ssrc=|url\(/u);
    expect(contents.match(/<link/gu)).toHaveLength(1);
    expect(contents).toContain('<link href="data:image/svg+xml,');
    expect(contents).toContain('rel="icon"');
    expect(contents).not.toContain(' style="');
    expect(contents.match(/<style>/gu)).toHaveLength(1);
    for (const slot of Object.values(OUTCOME_PAGE_SLOTS)) {
      expect(contents).toContain(slot);
    }
    // The tab reads like the web app's: "<title> | stella".
    expect(contents).toContain(
      `<title>${OUTCOME_PAGE_SLOTS.title} | stella</title>`,
    );
  }
  const [details, row] = [
    fragments.find(({ path }) => path.endsWith("details.gen.html")),
    fragments.find(({ path }) => path.endsWith("detail-row.gen.html")),
  ];
  expect(details?.contents).toContain(OUTCOME_FRAGMENT_SLOTS.rows);
  // A value is its own bidi run, so an email or a name keeps its order in a
  // right-to-left page.
  expect(row?.contents).toContain(`<bdi>${OUTCOME_FRAGMENT_SLOTS.value}</bdi>`);
  expect(row?.contents).toContain(OUTCOME_FRAGMENT_SLOTS.label);
});

test("every class the markup and its fragments use has a rule, and every token it reads is defined", () => {
  const fragmentMarkup = fragments.map(({ contents }) => contents).join("");
  for (const { contents } of pages) {
    const css = styleOf(contents);
    const classes = new Set(
      [...(contents + fragmentMarkup).matchAll(/\sclass="([^"]*)"/gu)].flatMap(
        ([, value]) => (value ?? "").split(/\s+/u).filter(Boolean),
      ),
    );
    const styled = new Set(
      [...css.matchAll(/\.((?:\\.|[\w-])+)/gu)].map(([, name]) =>
        unescapeClass(name ?? ""),
      ),
    );
    // lucide's own marker classes carry no utility.
    const unstyled = [...classes].filter(
      (name) => !name.startsWith("lucide") && !styled.has(name),
    );
    expect(unstyled).toEqual([]);

    const declared = new Set(
      [...css.matchAll(/(?<![\w-])(--[\w-]+)\s*:/gu)].map(([, name]) => name),
    );
    const undefinedTokens = [
      ...new Set(
        [...css.matchAll(/var\((--[\w-]+)\)/gu)].map(([, name]) => name),
      ),
    ].filter((name) => name !== undefined && !declared.has(name));
    expect(undefinedTokens).toEqual([]);
  }
});

test("draws in the scheme the listener names, else the system's, and drops motion when it is reduced", () => {
  const css = styleOf(pages[0]?.contents ?? "");
  expect(pages[0]?.contents).toContain(
    `data-theme="${OUTCOME_PAGE_SLOTS.theme}"`,
  );
  const darkTokens =
    /:root\[data-theme=dark\]\{color-scheme:dark;([^}]*)\}/u.exec(css)?.[1];
  const systemDark =
    /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme=light\]\)\{([^}]*)\}\}/u.exec(
      css,
    )?.[1];
  expect(darkTokens).toContain("--background:");
  // A forced dark page and a system-dark page draw the same tokens.
  expect(systemDark).toBe(darkTokens);
  expect(css).toContain(":root[data-theme=light]{color-scheme:light}");
  expect(css).toMatch(/prefers-reduced-motion: ?no-preference/u);
  expect(css).toContain("@keyframes outcome-badge");
});

test("the CLI carries the pages and fragments exactly, and both pages share one stylesheet", () => {
  const cli = artifacts.find(({ path }) =>
    path.endsWith("outcome-page.gen.ts"),
  );
  for (const { contents } of pages) {
    expect(cli?.contents).toContain(JSON.stringify(contents));
  }
  for (const { contents } of fragments) {
    expect(cli?.contents).toContain(JSON.stringify(contents.trimEnd()));
  }
  // The CLI admits the stylesheet by one hash, so the tones must not differ.
  expect(new Set(pages.map(({ contents }) => styleOf(contents))).size).toBe(1);
});
