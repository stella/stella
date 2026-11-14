import { expect, test } from "bun:test";
import path from "node:path";

import {
  findLoneSectionSignLines,
  findPlaceholderStellaMarkLines,
} from "../../scripts/check-desktop-section-sign-glyph.ts";

const fixture = async (name: string) =>
  Bun.file(path.join(import.meta.dir, "fixtures", name)).text();

test("rejects a lone section sign in static HTML", async () => {
  expect(
    findLoneSectionSignLines(
      await fixture("no-section-sign-glyph.failing.html"),
    ),
  ).toEqual([5]);
});

test("allows a section sign in a legal citation or a comment in static HTML", async () => {
  expect(
    findLoneSectionSignLines(
      await fixture("no-section-sign-glyph.passing.html"),
    ),
  ).toEqual([]);
});

test("rejects sampled popup markup and other static brand placeholders", async () => {
  expect(
    findPlaceholderStellaMarkLines(
      await fixture("no-placeholder-stella-mark.failing.html"),
    ),
  ).toEqual([2, 3, 4, 5, 6, 7, 8]);
});

test("allows legal signs, size labels, symbols, and code in Astro", async () => {
  expect(
    findPlaceholderStellaMarkLines(
      await fixture("no-placeholder-stella-mark.passing.astro"),
    ),
  ).toEqual([]);
});

test("detects static brand placeholders across Astro attribute spellings", () => {
  for (const text of [
    "S",
    "s",
    "§",
    "&sect;",
    "&#167;",
    "&#xa7;",
    '{"S"}',
    "{'s'}",
  ]) {
    for (const attributes of [
      'class="stella-mark"',
      "class='brand'",
      'aria-label="stella logo"',
      "data-app-icon",
      'data-role="brand"',
      "class=logo",
      'class={"mark"}',
      "class={'logo'}",
    ]) {
      expect(
        findPlaceholderStellaMarkLines(`<span ${attributes}>${text}</span>`),
      ).toEqual([1]);
    }
  }
});
