import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { failAfterTimeLimit, propertyConfig } from "@stll/property-testing";

/**
 * How a check under a failing time limit ended. fast-check interrupts in one
 * of two places, depending on when the clock passes the budget: between runs,
 * where the fail-on-interrupt plugin marks the run failed and throws, or
 * before the first run, where the run comes back already failed with no tests
 * run. Both are the same outcome, a run failed for being interrupted, so this
 * reads them as one and the assertion holds however long the runner took to
 * get started.
 */
const interruptedFailure = <Ts>(run: () => fc.RunDetails<Ts>): boolean => {
  try {
    const details = run();
    return details.failed && details.interrupted;
  } catch (error) {
    return (
      error instanceof Error && error.message.startsWith("Property interrupted")
    );
  }
};

describe("a property run under a failing time limit", () => {
  const holds = fc.property(fc.integer(), () => true);

  test("fails when its runs outlast the budget", () => {
    // A million runs cannot finish within a millisecond.
    expect(
      interruptedFailure(() =>
        fc.check(
          holds,
          propertyConfig({
            numRuns: 1_000_000,
            plugins: [failAfterTimeLimit(1)],
          }),
        ),
      ),
    ).toBe(true);
  });

  test("fails when the budget is spent before the first run", () => {
    expect(
      fc.check(
        holds,
        propertyConfig({ numRuns: 2, plugins: [failAfterTimeLimit(0)] }),
      ),
    ).toMatchObject({ failed: true, interrupted: true, numRuns: 0 });
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
