import { expect, test } from "bun:test";
import * as v from "valibot";

import {
  publicStatuteSearchSchema,
  readProvisionCitingSearch,
} from "./statute-page-search";

test("provision citation filters survive the statute route search contract", () => {
  const parsed = v.parse(publicStatuteSearchSchema, {
    q: " civil law ",
    citingCourt: " Nejvyšší soud ",
    citingYear: 2024,
    citingSort: "citations",
  });
  expect(readProvisionCitingSearch(parsed)).toEqual({
    citingCourt: "Nejvyšší soud",
    citingYear: 2024,
    citingSort: "citations",
  });
  expect(parsed.q).toBe("civil law");
  expect(readProvisionCitingSearch({})).toEqual({ citingSort: "newest" });
  for (const search of [
    { citingSort: "authority" },
    { citingYear: 0 },
    { citingYear: 2024.5 },
    { citingCourt: "x".repeat(513) },
  ]) {
    expect(v.safeParse(publicStatuteSearchSchema, search).success).toBe(false);
  }
});
