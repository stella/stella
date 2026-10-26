import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

// A sign-in destination can carry an OAuth request in its fragment, and a
// navigation by `to` drops the fragment: the client then never gets its code.
// Moving on to a `redirectTo` or other destination goes through
// `destinationNavigation`, which navigates by `href`. Found by scanning, so a
// new step cannot slip back.
const SOURCE = nodePath.resolve(import.meta.dir, "..");
const DESTINATION_VALUE =
  /(?:[\w$]+\.)*[\w$]*(?:[Rr]edirect|[Dd]estination|[Rr]eturnTo)[\w$]*/u.source;
const byTo = () =>
  new RegExp(
    String.raw`\b(?:navigate|redirect)\(\s*\{[^}]*?\bto:\s*${DESTINATION_VALUE}`,
    "gu",
  );
const BY_HELPER = /\bdestinationNavigation\(/u;
const HINT =
  "moves on to a destination by `to`, which drops its fragment; use destinationNavigation(...)";

const sources = [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: SOURCE })]
  .filter((file) => !/\.test\.tsx?$/u.test(file))
  .map((file) => ({
    file,
    text: readFileSync(nodePath.join(SOURCE, file), "utf-8"),
  }));

/** Each navigation by `to` in a text, as `<file>:<line>` with the hint. */
const navigationsByTo = (file: string, text: string) =>
  [...text.matchAll(byTo())].map(
    (match) =>
      `${file}:${text.slice(0, match.index).split("\n").length} ${HINT}`,
  );

describe("navigation to a sign-in destination", () => {
  test("the scan recognises a navigation by `to`", () => {
    for (const call of [
      "navigate({ to: redirectTo, replace: true })",
      "redirect({ to: search.redirectTo ?? '/', replace: true })",
      "redirect({\n  to: search.redirectTo,\n  throw: true,\n})",
      "navigate({ replace: true, to: destination })",
      "navigate({ to: toAppRedirectTo(search.redirectTo) })",
    ]) {
      expect(navigationsByTo("x.ts", call)).toHaveLength(1);
    }
    expect(
      navigationsByTo(
        "x.ts",
        'navigate({ to: "/auth", search: { redirectTo } })',
      ),
    ).toEqual([]);
    expect(navigationsByTo("x.ts", "\n\nnavigate({ to: redirectTo })")).toEqual(
      [`x.ts:3 ${HINT}`],
    );
  });

  test("the scan finds the steps that move on", () => {
    expect(
      sources
        .filter(({ text }) => BY_HELPER.test(text))
        .map(({ file }) => file),
    ).toEqual(
      expect.arrayContaining([
        "routes/auth/organization.tsx",
        "routes/auth/professional-use.tsx",
        "routes/auth/-components/professional-use-panel.tsx",
      ]),
    );
  });

  test("no step moves on to a destination by `to`", () => {
    expect(
      sources.flatMap(({ file, text }) => navigationsByTo(file, text)),
    ).toEqual([]);
  });
});
