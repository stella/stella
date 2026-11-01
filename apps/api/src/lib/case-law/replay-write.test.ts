import { describe, expect, test } from "bun:test";

import { caseLawSources } from "@/api/db/schema";

import { replayWrite } from "./replay-write";

describe("replay write plans", () => {
  test("a write with no values fails before a self-updating column joins it", () => {
    // `updatedAt` updates itself, so it must not make an empty write look
    // like one with a predicate that can never match.
    expect(() => replayWrite(caseLawSources, {})).toThrow(
      "Replay update has no written columns",
    );
  });

  test("a written value carries the self-updating column with it", () => {
    const plan = replayWrite(caseLawSources, { name: "Replay fixture" });
    expect(Object.keys(plan.set).toSorted()).toEqual(["name", "updatedAt"]);
  });
});
