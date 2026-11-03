import { expect, test } from "bun:test";

import { parseChangesetEntry, parseChangesetReleases } from "./changeset-entry";

test("changeset release kinds read quoted package names", () => {
  const entry = `---
"@stll/ui": major
'@stll/chat': minor
"@stll/money": patch
"@stll/html": none
---
Describe the release.
`;
  expect(parseChangesetReleases(entry)).toEqual([
    { name: "@stll/ui", type: "major" },
    { name: "@stll/chat", type: "minor" },
    { name: "@stll/money", type: "patch" },
  ]);
  expect(parseChangesetEntry(entry)).toEqual({
    packages: ["@stll/ui", "@stll/chat", "@stll/money", "@stll/html"],
    summary: "Describe the release.",
  });
});

test("the package list accepts a bare package name", () => {
  expect(
    parseChangesetEntry("---\n@stll/money: patch\n---\nSummary.").packages,
  ).toEqual(["@stll/money"]);
});

test.each([
  "Major",
  "majorly",
  "premajor",
  '"Major"',
  "# major",
  "",
  "false",
  "'major",
  ">\n  major",
])(
  "bump %j that Changesets rejects fails the check instead of authorizing",
  (bump) => {
    const entry = `---\n"@stll/ui": ${bump}\n---\nRelease summary.`;
    expect(() => parseChangesetReleases(entry)).toThrow(
      "Changesets cannot read a pending changeset",
    );
  },
);

test.each([
  ['"major"', "major"],
  ["'minor'", "minor"],
  ["major # breaking", "major"],
  ['"patch" # comment', "patch"],
  [">-\n  major", "major"],
  ["|-\n  minor", "minor"],
] as const)(
  "YAML bump %j reads as %s like the Changesets reader",
  (bump, type) => {
    const entry = `---\n"@stll/ui": ${bump}\n---\nRelease summary.`;
    expect(parseChangesetReleases(entry)).toEqual([{ name: "@stll/ui", type }]);
  },
);

test("frontmatter that is not a package mapping fails the check", () => {
  expect(() =>
    parseChangesetReleases("---\n- major\n---\nRelease summary."),
  ).toThrow("Changesets cannot read a pending changeset");
  expect(() =>
    parseChangesetReleases("---\n@stll/ui: major\n---\nRelease summary."),
  ).toThrow("Changesets cannot read a pending changeset");
});

test("empty changesets and summaries never authorize a release", () => {
  expect(parseChangesetReleases("")).toEqual([]);
  expect(parseChangesetReleases('---\n---\n"@stll/ui": major')).toEqual([]);
  expect(parseChangesetEntry("")).toEqual({ packages: [], summary: "" });
});

test("unterminated changeset frontmatter fails both readers", () => {
  const entry = '---\n"@stll/ui": major';
  expect(() => parseChangesetEntry(entry)).toThrow("unterminated frontmatter");
  expect(() => parseChangesetReleases(entry)).toThrow(
    "unterminated frontmatter",
  );
});
