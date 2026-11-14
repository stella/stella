import { SQL } from "bun";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import {
  DEFAULT_LOCK_RETRY_CONFIG,
  planLockRetry,
  runLockRetryLadder,
} from "./lock-retry-ladder";

const configs = fc.record({
  lockTimeoutsMs: fc
    .array(fc.integer({ min: 1, max: 2000 }), { minLength: 1, maxLength: 12 })
    .map((values) => values.toSorted((a, b) => a - b)),
  pauseBaseMs: fc.integer({ min: 0, max: 1000 }),
  pauseCapMs: fc.integer({ min: 0, max: 4000 }),
  budgetMs: fc.integer({ min: 0, max: 60_000 }),
});
const sample = fc.double({ min: 0, max: 1, noNaN: true });

test("lock retry plans preserve queue bounds and stop permanently", () => {
  assertProperty(
    "lock retry plans preserve queue bounds and stop permanently",
    fc.property(
      configs,
      fc.array(sample, { minLength: 16, maxLength: 16 }),
      (config, samples) => {
        let elapsedMs = 0;
        let previousTimeout = 0;
        let stopped = false;
        for (let attempt = 1; attempt <= 16; attempt += 1) {
          const plan = planLockRetry({
            config,
            attempt,
            elapsedMs,
            random: samples.at(attempt - 1) ?? 0,
          });
          if (plan.type === "stop") {
            stopped = true;
            continue;
          }
          expect(stopped).toBe(false);
          expect(plan.lockTimeoutMs).toBeGreaterThanOrEqual(previousTimeout);
          expect(plan.pauseMs).toBeGreaterThanOrEqual(0);
          expect(plan.pauseMs).toBeLessThanOrEqual(config.pauseCapMs);
          elapsedMs += plan.pauseMs + plan.lockTimeoutMs;
          expect(elapsedMs).toBeLessThanOrEqual(config.budgetMs);
          previousTimeout = plan.lockTimeoutMs;
        }
        expect(stopped).toBe(true);
      },
    ),
  );
});

const lockLoss = () =>
  new SQL.PostgresError("lock unavailable", {
    code: "ERR_POSTGRES_SERVER_ERROR",
    errno: "55P03",
    detail: "",
    hint: "",
    severity: "ERROR",
  });

test("lock retry execution spends only its planned queue budget", async () => {
  await assertProperty(
    "lock retry execution spends only its planned queue budget",
    fc.asyncProperty(configs, sample, async (config, random) => {
      let clock = 0;
      const timeouts: number[] = [];
      const pauses: number[] = [];
      const cause = lockLoss();
      const outcome = await runLockRetryLadder({
        config,
        now: () => clock,
        random: () => random,
        sleep: async (ms) => {
          pauses.push(ms);
          clock += ms;
        },
        attempt: async (timeout) => {
          timeouts.push(timeout);
          clock += timeout;
          throw cause;
        },
      });
      expect(outcome.type).toBe("stop");
      expect(clock).toBeLessThanOrEqual(config.budgetMs);
      expect(timeouts).toEqual(config.lockTimeoutsMs.slice(0, timeouts.length));
      expect(pauses.length).toBe(Math.max(0, timeouts.length - 1));
      if (outcome.type === "stop") {
        expect(outcome.attempts).toBe(timeouts.length);
        expect(outcome.cause).toBe(timeouts.length === 0 ? undefined : cause);
      }
    }),
  );
});

test("full jitter includes both ends of each exponentially capped pause", () => {
  for (
    let attempt = 2;
    attempt <= DEFAULT_LOCK_RETRY_CONFIG.lockTimeoutsMs.length;
    attempt += 1
  ) {
    const input = { config: DEFAULT_LOCK_RETRY_CONFIG, attempt, elapsedMs: 0 };
    expect(planLockRetry({ ...input, random: 0 })).toMatchObject({
      pauseMs: 0,
    });
    expect(planLockRetry({ ...input, random: 1 })).toMatchObject({
      pauseMs: Math.min(2000, 100 * 2 ** (attempt - 2)),
    });
  }
});

test("non-lock failures propagate unchanged on the initial attempt", async () => {
  await assertProperty(
    "non-lock failures propagate unchanged on the initial attempt",
    fc.asyncProperty(
      fc.constantFrom("40P01", "57014", "23505", "42501", "08006"),
      sample,
      async (errno, random) => {
        const failure = new SQL.PostgresError("statement failed", {
          code: "ERR_POSTGRES_SERVER_ERROR",
          errno,
          detail: "",
          hint: "",
          severity: "ERROR",
        });
        let attempts = 0;
        let sleeps = 0;
        expect(
          await rejectionOf(
            runLockRetryLadder({
              config: DEFAULT_LOCK_RETRY_CONFIG,
              now: () => 0,
              random: () => random,
              sleep: async () => {
                sleeps += 1;
              },
              attempt: async () => {
                attempts += 1;
                throw failure;
              },
            }),
          ),
        ).toBe(failure);
        expect(attempts).toBe(1);
        expect(sleeps).toBe(0);
      },
    ),
  );
});

test("time spent checking replay safety cannot start an attempt beyond budget", async () => {
  let clock = 0;
  let attempts = 0;
  const outcome = await runLockRetryLadder({
    config: DEFAULT_LOCK_RETRY_CONFIG,
    now: () => clock,
    random: () => 0,
    sleep: async () => {},
    beforeRetry: async () => {
      clock += DEFAULT_LOCK_RETRY_CONFIG.budgetMs;
    },
    attempt: async () => {
      attempts += 1;
      throw lockLoss();
    },
  });
  expect(outcome).toMatchObject({
    type: "stop",
    reason: "budget_spent",
    attempts: 1,
    lockTimeoutMs: 100,
  });
  expect(attempts).toBe(1);
});
