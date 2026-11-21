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
});

test("a citing filter the reader cannot use is dropped, not a failed page", () => {
  const parsed = v.parse(publicStatuteSearchSchema, {
    citingSort: "authority",
    citingCourt: "x".repeat(513),
  });
  expect(parsed.citingSort).toBeUndefined();
  expect(parsed.citingCourt).toBeUndefined();
});

test("a reloaded citing year reads from the URL's text", () => {
  expect(
    v.parse(publicStatuteSearchSchema, { citingYear: "2024" }).citingYear,
  ).toBe(2024);
});

test("a citing year that is not one is dropped, not a failed page", () => {
  for (const citingYear of [0, 2024.5, "", "20x4", "2024.5"]) {
    expect(
      v.parse(publicStatuteSearchSchema, { citingYear }).citingYear,
    ).toBeUndefined();
  }
});

test("a future as-of date survives the public statute search contract", () => {
  expect(v.parse(publicStatuteSearchSchema, { asOf: "2027-01-01" }).asOf).toBe(
    "2027-01-01",
  );
});
