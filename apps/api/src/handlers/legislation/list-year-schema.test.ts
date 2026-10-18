import { Value } from "@sinclair/typebox/value";
import { expect, test } from "bun:test";
import * as v from "valibot";

import { lawYearSearchSchema } from "@stll/api-contract/law-year";

import { listStatutesQuerySchema } from "./list";

test.each([
  { year: 1000, accepted: true },
  { year: 2026, accepted: true },
  { year: 9999, accepted: true },
  { year: 999, accepted: false },
  { year: 10_000, accepted: false },
  { year: 2026.5, accepted: false },
  { year: Number.NaN, accepted: false },
  { year: Number.POSITIVE_INFINITY, accepted: false },
])("API and web accept the same integer year: $year", ({ year, accepted }) => {
  expect(Value.Check(listStatutesQuerySchema, { country: "CZE", year })).toBe(
    accepted,
  );
  expect(v.safeParse(lawYearSearchSchema, year).success).toBe(accepted);
});
