import { expect, test } from "bun:test";
import path from "node:path";

import { findLoneSectionSignLines } from "../../scripts/check-desktop-section-sign-glyph.ts";

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
