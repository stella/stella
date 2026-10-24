import { panic } from "better-result";
import fc from "fast-check";

import { PropertyTestConfigError } from "./property-test-config-error";

/**
 * Responses a scenario holds back so fast-check decides the order in which
 * they reach the code under test.
 */
export type ResponseOrder = {
  /**
   * Holds a response until the scheduler releases it; `deliver` runs at
   * release and its return value (or throw) is what the caller receives.
   * Compute the outcome when the request is made and only deliver it here,
   * as a real backend answers in request order while replies land in any.
   */
  hold: <T>(label: string, deliver: () => T) => Promise<T>;
  /** Releases one held response, if any, chosen by the scheduler. */
  releaseOne: () => Promise<void>;
  /** Releases every held response, including ones released responses cause. */
  settle: () => Promise<void>;
};

type ResponseOrderPropertyOptions<Scenario> = {
  /** The operations to issue; keep at least two responses in flight. */
  scenario: fc.Arbitrary<Scenario>;
  /** Issues the scenario, settles its responses and asserts on the result. */
  run: (order: ResponseOrder, scenario: Scenario) => Promise<void>;
  /** Wraps each release, e.g. React's `act`, so updates flush before the next. */
  act?: fc.SchedulerAct;
};

/**
 * Builds an async property that replays `scenario` under every response order
 * fast-check explores, for `assertProperty`. A run fails as a misconfigured
 * scenario when it never had two responses in flight (no order to explore) or
 * leaves a response unreleased (its assertions saw a partial state).
 */
export const responseOrderProperty = <Scenario>({
  scenario,
  run,
  act,
}: ResponseOrderPropertyOptions<Scenario>) =>
  fc.asyncProperty(
    fc.scheduler(act === undefined ? undefined : { act }),
    scenario,
    async (scheduler, input) => {
      let inFlight = 0;
      let maxInFlight = 0;
      const order: ResponseOrder = {
        hold: async (label, deliver) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          return scheduler
            .schedule(Promise.resolve(), label)
            .then(deliver)
            .finally(() => {
              inFlight -= 1;
            });
        },
        releaseOne: async () => {
          if (scheduler.count() > 0) {
            await scheduler.waitNext(1);
          }
        },
        settle: async () => await scheduler.waitIdle(),
      };
      await run(order, input);
      if (scheduler.count() > 0) {
        const error = new PropertyTestConfigError(
          `Response-order scenario asserted with ${scheduler.count()} response(s) still held; call settle() first`,
        );
        panic(error.message, error);
      }
      if (maxInFlight < 2) {
        const error = new PropertyTestConfigError(
          "Response-order scenario never had two responses in flight, so no order was explored",
        );
        panic(error.message, error);
      }
    },
  );
