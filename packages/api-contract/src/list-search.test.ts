import { describe, expect, test } from "bun:test";

import { listRowMatches } from "./list-search";

const row = [
  "Vyjádření k žalobě",
  "JUDr. Tereza Hromádková <hromadkova@ak-kalina-vesela.cz>",
  "Spisy/Stavby Hradec",
];

describe("a list row and a search", () => {
  test.each([
    ["", true],
    ["   ", true],
    ["vyjadreni", true],
    ["VYJÁDŘENÍ", true],
    ["hradec zalobe", true],
    ["hromadkova@ak", true],
    ["smlouva", false],
    ["hradec smlouva", false],
  ])("%j matches: %p", (query, matches) => {
    expect(listRowMatches(row, query)).toBe(matches);
  });

  test("a missing text is skipped, never matched as a word", () => {
    expect(listRowMatches([null, undefined, "plna-moc.pdf"], "null")).toBe(
      false,
    );
    expect(listRowMatches([null, "plna-moc.pdf"], "moc")).toBe(true);
  });
});
