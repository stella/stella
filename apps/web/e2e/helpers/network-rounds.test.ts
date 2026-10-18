import { expect, test } from "bun:test";

import {
  createNetworkRoundController,
  NETWORK_ROUND_SETTLE_MS as S,
} from "./network-rounds";

test("late independent siblings share a level and neither response escapes early", () => {
  const controller = createNetworkRoundController<string>();
  // Both follow responses delivered at zero; B's render work takes longer.
  controller.arrive({ token: "A", key: "A", now: 0 });
  controller.complete("A");
  expect(controller.release(299)).toEqual([]);
  controller.arrive({ token: "B", key: "B", now: 300 });
  controller.complete("B");
  expect(controller.release(300 + S - 1)).toEqual([]);
  expect(controller.release(300 + S)).toEqual(["A", "B"]);
  expect(controller.rounds).toEqual([["A", "B"]]);
  controller.finish();
});

test("response-driven A to B to C requires three delivery rounds", () => {
  const controller = createNetworkRoundController<string>();
  for (const [level, token] of ["A", "B", "C"].entries()) {
    const arrival = level * S;
    controller.arrive({ token, key: token, now: arrival });
    controller.complete(token);
    expect(controller.release(arrival + S - 1)).toEqual([]);
    expect(controller.release(arrival + S)).toEqual([token]);
  }
  expect(controller.rounds).toEqual([["A"], ["B"], ["C"]]);
  controller.finish();
});

test("late skill availability shares level five with time timers", () => {
  const controller = createNetworkRoundController<string>();
  for (let level = 1; level <= 4; level++) {
    const token = `dependency-${String(level)}`;
    const arrival = (level - 1) * S;
    controller.arrive({ token, key: token, now: arrival });
    controller.complete(token);
    expect(controller.release(arrival + S)).toEqual([token]);
  }
  controller.arrive({
    token: "timers",
    key: "GET /v1/time-timers",
    now: 4 * S,
  });
  controller.complete("timers");
  expect(controller.release(4 * S + 299)).toEqual([]);
  controller.arrive({
    token: "skills",
    key: "GET /v1/chat/skill-availability",
    now: 4 * S + 300,
  });
  controller.complete("skills");
  expect(controller.release(5 * S + 299)).toEqual([]);
  expect(controller.release(5 * S + 300)).toEqual(["timers", "skills"]);
  expect(controller.rounds).toEqual([
    ["dependency-1"],
    ["dependency-2"],
    ["dependency-3"],
    ["dependency-4"],
    ["GET /v1/time-timers", "GET /v1/chat/skill-availability"],
  ]);
  controller.finish();
});

test("aborts in flight or while held never count", () => {
  for (const state of ["in-flight", "held"] as const) {
    const controller = createNetworkRoundController<string>();
    controller.arrive({ token: "aborted", key: "aborted", now: 0 });
    if (state === "held") {
      controller.complete("aborted");
    }
    controller.abort("aborted");
    expect(controller.release(S)).toEqual([]);
    expect(controller.rounds).toEqual([]);
    expect(controller.pending).toBe(false);
    controller.finish();
  }
});

test("finishing with an in-flight request or held response rejects incomplete depth", () => {
  for (const state of ["in-flight", "held"] as const) {
    const controller = createNetworkRoundController<string>();
    controller.arrive({ token: "pending", key: "pending", now: 0 });
    if (state === "held") {
      controller.complete("pending");
    }
    expect(() => controller.finish()).toThrow("did not drain");
    expect(controller.loaded).toBe(true);
    expect(controller.release(S)).toEqual([]);
  }
});
