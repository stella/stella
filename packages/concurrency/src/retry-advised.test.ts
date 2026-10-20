import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  ADVISED_RETRY_MAX_ATTEMPTS,
  ADVISED_RETRY_MAX_DELAY_MS,
  advisedRetry,
} from "./retry-advised";

test("advised retries respect advice, the cap, and the attempt bound", () => {
  assertProperty(
    "advised retries respect advice, the cap, and the attempt bound",
    fc.property(
      fc.integer({ min: 1, max: 20 }),
      fc.option(fc.integer({ min: 0, max: 60_000 }), { nil: undefined }),
      (attempt, advisedDelayMs) => {
        const decision = advisedRetry({ attempt, advisedDelayMs });
        if (attempt >= ADVISED_RETRY_MAX_ATTEMPTS) {
          expect(decision).toEqual({ type: "give-up" });
          return;
        }
        expect(decision.type).toBe("retry");
        if (decision.type !== "retry") {
          return;
        }
        expect(decision.delayMs).toBeLessThanOrEqual(
          ADVISED_RETRY_MAX_DELAY_MS,
        );
        if (
          advisedDelayMs !== undefined &&
          advisedDelayMs <= ADVISED_RETRY_MAX_DELAY_MS
        ) {
          expect(decision.delayMs).toBeGreaterThanOrEqual(advisedDelayMs);
        }
      },
    ),
  );
});
