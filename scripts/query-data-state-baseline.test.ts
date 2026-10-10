import { expect, test } from "bun:test";

import { exactSetDifference } from "./rule-census.ts";

test("query state entries must match the observed set in both directions", () => {
  expect(
    exactSetDifference({
      observed: ["file::List::data"],
      recorded: ["file::List::data"],
      committed: null,
    }),
  ).toEqual({ added: [], stale: [], duplicates: [], grown: [] });
  expect(
    exactSetDifference({
      observed: ["file::List::data", "file::New::data"],
      recorded: ["file::List::data"],
      committed: null,
    }),
  ).toEqual({
    added: ["file::New::data"],
    stale: [],
    duplicates: [],
    grown: [],
  });
  expect(
    exactSetDifference({
      observed: [],
      recorded: ["file::List::data"],
      committed: null,
    }),
  ).toEqual({
    added: [],
    stale: ["file::List::data"],
    duplicates: [],
    grown: [],
  });
});

test("query bindings cannot collapse into a duplicate baseline key", () => {
  expect(
    exactSetDifference({
      observed: ["file::List::data", "file::List::data"],
      recorded: ["file::List::data"],
      committed: null,
    }).duplicates,
  ).toEqual(["file::List::data"]);
});

test("a new committed baseline key fails even when the observed set matches", () => {
  const recorded = ["file::List::data", "file::New::data"];
  expect(
    exactSetDifference({
      observed: recorded,
      recorded,
      committed: ["file::List::data"],
    }),
  ).toEqual({
    added: [],
    stale: [],
    duplicates: [],
    grown: ["file::New::data"],
  });
});
