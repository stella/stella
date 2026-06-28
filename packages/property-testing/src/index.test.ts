import { afterEach, describe, expect, test } from "bun:test";

import { propertyConfig } from "./index";

const FACTOR_ENV = "PROPERTY_TEST_NUM_RUNS_FACTOR";

const withEnv = (
  overrides: Record<string, string | undefined>,
  run: () => void,
): void => {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    previous.set(key, process.env[key]);
    const next = overrides[key];
    if (next === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = next;
    }
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  }
};

afterEach(() => {
  Reflect.deleteProperty(process.env, FACTOR_ENV);
});

describe("propertyConfig", () => {
  test("passes per-test numRuns through unchanged at the neutral factor", () => {
    withEnv({ [FACTOR_ENV]: undefined }, () => {
      expect(propertyConfig({ numRuns: 200 }).numRuns).toBe(200);
    });
  });

  test("defaults to fast-check's own numRuns when none is given", () => {
    withEnv({ [FACTOR_ENV]: undefined }, () => {
      expect(propertyConfig().numRuns).toBe(100);
    });
  });

  test("scales numRuns by the nightly factor (rounding up)", () => {
    withEnv({ [FACTOR_ENV]: "10" }, () => {
      expect(propertyConfig({ numRuns: 50 }).numRuns).toBe(500);
    });
    withEnv({ [FACTOR_ENV]: "2.5" }, () => {
      // 75 * 2.5 = 187.5 -> 188
      expect(propertyConfig({ numRuns: 75 }).numRuns).toBe(188);
    });
  });

  test("ignores a factor below 1 or non-numeric so coverage never weakens", () => {
    for (const raw of ["0", "0.5", "-3", "abc", ""]) {
      withEnv({ [FACTOR_ENV]: raw }, () => {
        expect(propertyConfig({ numRuns: 80 }).numRuns).toBe(80);
      });
    }
  });

  test("enables verbose reporting under CI, quiet otherwise", () => {
    withEnv({ CI: "true" }, () => {
      expect(propertyConfig().verbose).toBe(true);
    });
    withEnv({ CI: undefined }, () => {
      expect(propertyConfig().verbose).toBe(false);
    });
  });

  test("lets a caller override the defaults explicitly", () => {
    withEnv({ CI: "true", [FACTOR_ENV]: "10" }, () => {
      const params = propertyConfig({ numRuns: 30, verbose: false });
      expect(params.verbose).toBe(false);
      // numRuns is still scaled from the caller's per-test budget.
      expect(params.numRuns).toBe(300);
    });
  });
});
