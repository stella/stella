import { expect, test } from "bun:test";

import { parseChangesetEntry, parseChangesetReleases } from "./changeset-entry";

test("changeset release kinds accept quoted and bare package names", () => {
  const entry = `---
"@stll/ui": major
'@stll/chat': minor
@stll/money: patch
---
Describe the release.
`;
  expect(parseChangesetReleases(entry)).toEqual([
    { name: "@stll/ui", type: "major" },
    { name: "@stll/chat", type: "minor" },
    { name: "@stll/money", type: "patch" },
  ]);
  expect(parseChangesetEntry(entry)).toEqual({
    packages: ["@stll/ui", "@stll/chat", "@stll/money"],
    summary: "Describe the release.",
  });
});

test.each([
  "Major",
  "majorly",
  "premajor",
  '"major"',
  "major # comment",
  "",
  "false",
])("invalid bump %s cannot authorize a breaking release", (bump) => {
  const entry = `---\n"@stll/ui": ${bump}\n---\nRelease summary.`;
  expect(parseChangesetReleases(entry)).toEqual([]);
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
