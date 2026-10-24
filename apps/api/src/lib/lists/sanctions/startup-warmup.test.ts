import { expect, test } from "bun:test";

import { createSanctionsStartupWarmup } from "@/api/lib/lists/sanctions/startup-warmup";

const list = (
  reason: "warming" | "load-failed" | null,
  loaderState: "warming" | "retrying" | "terminal" | null = null,
) => ({
  source: "eu" as const,
  reason,
  loaderState,
});

test("a list stuck warming becomes a named terminal failure at the bound", async () => {
  let instant = 0;
  const warmup = createSanctionsStartupWarmup({
    screen: async () => [list("warming")],
    now: () => instant,
    sleep: async () => {
      instant = 100;
    },
    terminalize: () => undefined,
    boundMs: 100,
  });

  warmup.start();
  await warmup.settled();

  expect(warmup.status()).toEqual({
    status: "terminal",
    reason: "warming-bound-exceeded",
    lists: new Map([["eu", "load-failed"]]),
  });
});

test("a failed attempt in retry backoff is not terminal", async () => {
  let instant = 0;
  let calls = 0;
  const warmup = createSanctionsStartupWarmup({
    screen: async () => {
      calls++;
      return calls === 1 ? [list("load-failed", "retrying")] : [list(null)];
    },
    now: () => instant,
    sleep: async () => {
      instant++;
    },
    terminalize: () => undefined,
    boundMs: 10,
  });

  warmup.start();
  await warmup.settled();

  expect(calls).toBe(2);
  expect(warmup.status()).toMatchObject({
    status: "terminal",
    reason: "settled",
  });
});

test("a rejecting screen is captured and retried until it settles", async () => {
  let instant = 0;
  let calls = 0;
  const warmup = createSanctionsStartupWarmup({
    screen: async () => {
      calls++;
      if (calls === 1) {
        throw new Error("temporary screening failure");
      }
      return [list(null)];
    },
    now: () => instant,
    sleep: async () => {
      instant++;
    },
    terminalize: () => undefined,
    boundMs: 10,
  });

  warmup.start();
  await warmup.settled();

  expect(calls).toBe(2);
  expect(warmup.status().status).toBe("terminal");
});

test("the bound terminalizes the matcher state used by public screening", async () => {
  let instant = 0;
  let loaderState = "warming" as "warming" | "terminal";
  const warmup = createSanctionsStartupWarmup({
    screen: async () => [
      list(loaderState === "terminal" ? "load-failed" : "warming", loaderState),
    ],
    now: () => instant,
    sleep: async () => {
      instant = 100;
    },
    terminalize: () => {
      loaderState = "terminal";
    },
    boundMs: 100,
  });

  warmup.start();
  await warmup.settled();

  expect(warmup.status().status).toBe("terminal");
  expect(loaderState).toBe("terminal");
});
