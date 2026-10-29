import { Panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertyConfig } from "@stll/property-testing";

import { PropertyTestConfigError } from "./property-test-config-error";
import { responseOrderProperty } from "./response-order";
import type { ResponseOrder } from "./response-order";

type Store = { shown: number | null; issue: (value: number) => void };

// Each request asks the backend for `value`; the store shows what the reply carries.
const lastArrivalStore = (order: ResponseOrder): Store => {
  const store: Store = {
    shown: null,
    issue: (value) => {
      void order
        .hold(`reply ${value}`, () => value)
        .then((reply) => {
          store.shown = reply;
          return undefined;
        });
    },
  };
  return store;
};

const latestRequestStore = (order: ResponseOrder): Store => {
  let latest = 0;
  const store: Store = {
    shown: null,
    issue: (value) => {
      latest += 1;
      const request = latest;
      void order
        .hold(`reply ${value}`, () => value)
        .then((reply) => {
          if (request === latest) {
            store.shown = reply;
          }
          return undefined;
        });
    },
  };
  return store;
};

const requests = fc.uniqueArray(fc.integer(), { minLength: 2, maxLength: 5 });

const showsNewest =
  (makeStore: (order: ResponseOrder) => Store) =>
  async (order: ResponseOrder, values: number[]) => {
    const store = makeStore(order);
    for (const value of values) {
      store.issue(value);
    }
    await order.settle();
    expect(store.shown).toBe(values.at(-1) ?? null);
  };

describe("response-order property", () => {
  test("finds a reply that lands after a newer one and overwrites it", async () => {
    const details = await fc.check(
      responseOrderProperty({
        scenario: requests,
        run: showsNewest(lastArrivalStore),
      }),
      propertyConfig({ numRuns: 100 }),
    );
    expect(details.failed).toBe(true);
    expect(details.errorInstance).not.toBeInstanceOf(Panic);
  });

  test("a store that applies only its latest request shows the newest reply in every order", async () => {
    await assertProperty(
      "a store that applies only its latest request shows the newest reply in every order",
      responseOrderProperty({
        scenario: requests,
        run: showsNewest(latestRequestStore),
      }),
      { numRuns: 100 },
    );
  });

  test("rejects a scenario that never has two replies in flight", async () => {
    const details = await fc.check(
      responseOrderProperty({
        scenario: fc.integer(),
        run: async (order, value) => {
          const store = lastArrivalStore(order);
          store.issue(value);
          await order.settle();
        },
      }),
      propertyConfig({ numRuns: 1 }),
    );
    expect(details.errorInstance).toBeInstanceOf(Panic);
    expect(details.errorInstance).toHaveProperty(
      "cause",
      expect.any(PropertyTestConfigError),
    );
    expect(String(details.errorInstance)).toContain(
      "never had two responses in flight",
    );
  });

  test("rejects a scenario that asserts before releasing every reply", async () => {
    const details = await fc.check(
      responseOrderProperty({
        scenario: requests,
        run: async (order, values) => {
          const store = lastArrivalStore(order);
          for (const value of values) {
            store.issue(value);
          }
          await order.releaseOne();
        },
      }),
      propertyConfig({ numRuns: 1 }),
    );
    expect(details.errorInstance).toBeInstanceOf(Panic);
    expect(details.errorInstance).toHaveProperty(
      "cause",
      expect.any(PropertyTestConfigError),
    );
    expect(String(details.errorInstance)).toContain("still held");
  });

  test("rejects released responses whose delivery is still pending", async () => {
    const delivery = Promise.withResolvers<undefined>();
    let response: Promise<void> | undefined;
    try {
      const details = await fc.check(
        responseOrderProperty({
          scenario: fc.constant(null),
          run: async (order) => {
            response = Promise.all([
              order.hold(
                "pending delivery",
                async () => await delivery.promise,
              ),
              order.hold("other reply", () => undefined),
            ]).then(() => undefined);
            await order.settle();
          },
        }),
        propertyConfig({ numRuns: 1, endOnFailure: true }),
      );
      expect(details.errorInstance).toBeInstanceOf(Panic);
      expect(details.errorInstance).toHaveProperty(
        "cause",
        expect.any(PropertyTestConfigError),
      );
      expect(String(details.errorInstance)).toContain("still delivering");
    } finally {
      delivery.resolve(undefined);
      await response;
    }
  });
});
