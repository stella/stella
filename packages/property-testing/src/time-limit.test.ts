import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { failAfterTimeLimit, propertyConfig } from "@stll/property-testing";

describe("a property run under a failing time limit", () => {
  const holds = fc.property(fc.integer(), () => true);

  test("fails when its runs outlast the budget", () => {
    // A million runs cannot finish within a millisecond.
    expect(() =>
      fc.check(
        holds,
        propertyConfig({
          numRuns: 1_000_000,
          plugins: [failAfterTimeLimit(1)],
        }),
      ),
    ).toThrow("Property interrupted");
  });

  test("passes when its runs finish within the budget", () => {
    expect(
      fc.check(
        holds,
        propertyConfig({ numRuns: 2, plugins: [failAfterTimeLimit(60_000)] }),
      ),
    ).toMatchObject({ failed: false, interrupted: false });
  });
});
