import { panic } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { countsTowardsWaterfall } from "../helpers/network";
import {
  createNetworkRoundController,
  NETWORK_ROUND_SETTLE_MS,
} from "../helpers/network-rounds";

type Node = { parents: number[]; duration: number };
const simulate = (nodes: Node[]) => {
  const controller = createNetworkRoundController<number>();
  const released = new Set<number>();
  const arrived = new Set<number>();
  const completing = new Map<number, number>();
  let now = 0;
  const arriveReady = () => {
    let didArrive = false;
    for (const [id, node] of nodes.entries()) {
      if (
        arrived.has(id) ||
        !node.parents.every((parent) => released.has(parent))
      ) {
        continue;
      }
      arrived.add(id);
      controller.arrive({ token: id, key: String(id), now });
      completing.set(id, now + node.duration);
      didArrive = true;
    }
    return didArrive;
  };
  arriveReady();
  while (released.size < nodes.length) {
    const nextCompletion = Math.min(...completing.values());
    const nextRelease = now + NETWORK_ROUND_SETTLE_MS;
    now = Math.min(nextCompletion, nextRelease);
    for (const [id, end] of completing) {
      if (end > now) {
        continue;
      }
      completing.delete(id);
      controller.complete(id);
    }
    const tokens = controller.release(now);
    for (const id of tokens) {
      released.add(id);
    }
    if (tokens.length > 0) {
      arriveReady();
    }
  }
  return controller.rounds;
};

test("independent branches share round two despite unequal parent response times", () => {
  expect(
    simulate([
      { parents: [], duration: 1 },
      { parents: [], duration: 10_000 },
      { parents: [0], duration: 1 },
      { parents: [1], duration: 1 },
    ]),
  ).toEqual([
    ["0", "1"],
    ["2", "3"],
  ]);
});

test("a dependency on round two releases in round three", () => {
  expect(
    simulate([
      { parents: [], duration: 100 },
      { parents: [0], duration: 10 },
      { parents: [1], duration: 1 },
    ]),
  ).toEqual([["0"], ["1"], ["2"]]);
});

test("invoices new retains five rounds for arbitrary response completion orders", () => {
  const parents = [[], [0], [1], [1], [1], [2], [5], [5], [5], [5], [5], [5]];
  assertProperty(
    "invoices new retains five rounds for arbitrary response completion orders",
    fc.property(
      fc.array(fc.integer({ min: 1, max: 100_000 }), {
        minLength: parents.length,
        maxLength: parents.length,
      }),
      (durations) => {
        expect(
          simulate(
            parents.map((dependencies, id) => ({
              parents: dependencies,
              duration:
                durations.at(id) ??
                panic("generator must supply every duration"),
            })),
          ),
        ).toEqual([
          ["0"],
          ["1"],
          ["2", "3", "4"],
          ["5"],
          ["6", "7", "8", "9", "10", "11"],
        ]);
      },
    ),
  );
});

test("random request graphs have depth equal to their longest path", () => {
  assertProperty(
    "random request graphs have depth equal to their longest path",
    fc.property(
      fc.array(
        fc.record({
          dependencies: fc.array(fc.nat({ max: 50 }), { maxLength: 8 }),
          duration: fc.integer({ min: 1, max: 100_000 }),
        }),
        { minLength: 1, maxLength: 30 },
      ),
      (samples) => {
        const nodes = samples.map(({ dependencies, duration }, id) => ({
          parents:
            id === 0
              ? []
              : [...new Set(dependencies.map((parent) => parent % id))],
          duration,
        }));
        const paths: number[] = [];
        for (const node of nodes) {
          paths.push(
            1 +
              Math.max(
                0,
                ...node.parents.map(
                  (parent) =>
                    paths.at(parent) ??
                    panic("parents must precede their children"),
                ),
              ),
          );
        }
        expect(simulate(nodes).length).toBe(Math.max(...paths));
      },
    ),
  );
});

test("arrivals restart settle and unfinished peers prevent release", () => {
  const controller = createNetworkRoundController<string>();
  controller.arrive({ token: "a", key: "a", now: 0 });
  controller.arrive({ token: "b", key: "b", now: 100 });
  controller.complete("a");
  expect(controller.release(150)).toEqual([]);
  controller.complete("b");
  expect(controller.release(599)).toEqual([]);
  expect(controller.release(600)).toEqual(["a", "b"]);
  controller.arrive({ token: "child", key: "child", now: 610 });
  controller.complete("child");
  expect(controller.release(1109)).toEqual([]);
  expect(controller.release(1110)).toEqual(["child"]);
});

test("loaded routes never open rounds for idle prefetch", () => {
  const controller = createNetworkRoundController<string>();
  expect(controller.rounds).toEqual([]);
  controller.arrive({ token: "a", key: "a", now: 0 });
  controller.complete("a");
  expect(controller.release(499)).toEqual([]);
  expect(controller.release(500)).toEqual(["a"]);
  controller.finish();
  controller.arrive({ token: "prefetch", key: "prefetch", now: 1000 });
  expect(controller.release(2000)).toEqual([]);
  expect(controller.rounds).toEqual([["a"]]);
});

test("a request aborted while held adds no round and blocks none", () => {
  const controller = createNetworkRoundController<string>();
  controller.arrive({ token: "aborted", key: "GET /aborted", now: 0 });
  // The page abandons the request before the barrier releases it.
  expect(controller.holds("aborted")).toBe(true);
  controller.abort("aborted");
  expect(controller.holds("aborted")).toBe(false);
  controller.arrive({ token: "kept", key: "GET /kept", now: 20 });
  controller.complete("kept");
  const released = controller.release(20 + NETWORK_ROUND_SETTLE_MS);
  expect(released).toEqual(["kept"]);
  expect(controller.pending).toBe(false);
  expect(controller.rounds).toEqual([["GET /kept"]]);
});

test("a background poll before release never joins a round", () => {
  const controller = createNetworkRoundController<string>();
  const arrive = (token: string, pathname: string, now: number) => {
    if (countsTowardsWaterfall({ pathname, resourceType: "fetch" })) {
      controller.arrive({ token, key: `GET ${pathname}`, now });
    }
  };

  arrive("route", "/v1/matters", 0);
  arrive("poll", "/health", 100);
  controller.complete("route");
  expect(controller.release(499)).toEqual([]);
  expect(controller.release(500)).toEqual(["route"]);
  expect(controller.rounds).toEqual([["GET /v1/matters"]]);
});

test("a background poll while a round is in flight never adds depth", () => {
  const controller = createNetworkRoundController<string>();
  const arrive = (token: string, pathname: string, now: number) => {
    if (countsTowardsWaterfall({ pathname, resourceType: "fetch" })) {
      controller.arrive({ token, key: `GET ${pathname}`, now });
    }
  };

  arrive("route", "/v1/matters", 0);
  controller.complete("route");
  expect(controller.release(500)).toEqual(["route"]);
  arrive("poll", "/health", 600);
  expect(controller.release(1000)).toEqual([]);
  expect(controller.rounds).toEqual([["GET /v1/matters"]]);
});

test("finishing while a round is held or in flight rejects the measurement", () => {
  const controller = createNetworkRoundController<string>();
  controller.arrive({ token: "slow", key: "slow", now: 0 });
  controller.complete("slow");
  expect(controller.release(500)).toEqual(["slow"]);
  // A dependent arrives while held behind the active request.
  controller.arrive({ token: "dependent", key: "dependent", now: 510 });
  expect(() => {
    controller.finish();
  }).toThrow("did not drain");
  // Held requests are still let through, and nothing records another round.
  expect(controller.loaded).toBe(true);
  expect(controller.holds("dependent")).toBe(false);
  expect(controller.rounds).toEqual([["slow"]]);
});

test("finishing after every round completed accepts the measurement", () => {
  const controller = createNetworkRoundController<string>();
  controller.arrive({ token: "a", key: "a", now: 0 });
  controller.complete("a");
  expect(controller.release(500)).toEqual(["a"]);
  expect(() => {
    controller.finish();
  }).not.toThrow();
});
