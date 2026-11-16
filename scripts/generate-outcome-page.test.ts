import { expect, test } from "bun:test";

import {
  OUTCOME_PAGE_SLOTS,
  outcomePageArtifacts,
  styleHash,
} from "./generate-outcome-page";

const artifacts = await outcomePageArtifacts();
const pages = artifacts.filter(({ path }) => path.endsWith(".html"));

const styleOf = (page: string) =>
  /<style>([\s\S]*)<\/style>/u.exec(page)?.[1] ?? "";

const unescapeClass = (selector: string) => selector.replaceAll("\\", "");

test("renders one self-contained page per tone", () => {
  expect(
    pages.map(({ path }) => path.replace(/^.*\//u, "")).toSorted(),
  ).toEqual(["outcome-page.error.gen.html", "outcome-page.success.gen.html"]);
  for (const { contents } of pages) {
    expect(contents.startsWith("<!doctype html>")).toBe(true);
    // Loads nothing: the listeners' CSP is `default-src 'none'`.
    expect(contents).not.toMatch(/<script|<link|\ssrc=|url\(/u);
    expect(contents).not.toContain(' style="');
    expect(contents.match(/<style>/gu)).toHaveLength(1);
    for (const slot of Object.values(OUTCOME_PAGE_SLOTS)) {
      expect(contents).toContain(slot);
    }
  }
});

test("every class the markup uses has a rule, and every token it reads is defined", () => {
  for (const { contents } of pages) {
    const css = styleOf(contents);
    const classes = new Set(
      [...contents.matchAll(/\sclass="([^"]*)"/gu)].flatMap(([, value]) =>
        (value ?? "").split(/\s+/u).filter(Boolean),
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

test("follows the system colour scheme and drops motion when it is reduced", () => {
  const css = styleOf(pages[0]?.contents ?? "");
  expect(css).toContain("@media (prefers-color-scheme:dark)");
  expect(css).toMatch(/prefers-reduced-motion:no-preference/u);
  expect(css).toContain("@keyframes outcome-badge");
});

test("the CLI's template and CSP hash match the pages exactly", () => {
  const cli = artifacts.find(({ path }) =>
    path.endsWith("outcome-page.gen.ts"),
  );
  for (const { contents } of pages) {
    expect(cli?.contents).toContain(JSON.stringify(contents));
    expect(cli?.contents).toContain(
      JSON.stringify(styleHash(styleOf(contents))),
    );
  }
});
