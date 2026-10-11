import { expect, test } from "bun:test";

const coverageSource = await Bun.file(
  new URL("coverage.ts", import.meta.url),
).text();

test("coverage year bounds cannot read capped facet years", () => {
  expect(coverageSource).not.toContain("facets.value.year");
  expect(coverageSource).not.toContain("decisionYearBounds");
});
