import { Result } from "better-result";
import { expect, test } from "bun:test";

import { createSanctionsStartupWarmup } from "@/api/lib/lists/sanctions/startup-warmup";

type LoaderState = "warming" | "retrying" | "terminal" | null;

const list = (
  reason: "warming" | "load-failed" | "not-loaded" | "stale" | null,
  loaderState: LoaderState = null,
) => ({
  source: "eu" as const,
  reason,
  loaderState,
});

const screened = async (...lists: ReturnType<typeof list>[]) =>
  Result.ok(lists);

test("a list stuck warming becomes a named terminal failure at the bound", async () => {
  let instant = 0;
  const warmup = createSanctionsStartupWarmup({
    screen: async () => await screened(list("warming", "warming")),
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
    lists: new Map([["eu", "unavailable"]]),
  });
});

test.each([
  ["initial warming after an early load failure", "warming"],
  ["retry backoff", "retrying"],
] as const)(
  "a load failure the loader is still working on (%s) keeps startup polling",
  async (_label, loaderState) => {
    let instant = 0;
    let calls = 0;
    const warmup = createSanctionsStartupWarmup({
      screen: async () => {
        calls++;
        return calls === 1
          ? await screened(list("load-failed", loaderState))
          : await screened(list(null));
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
    expect(warmup.status()).toEqual({
      status: "terminal",
      reason: "settled",
      lists: new Map([["eu", "warm"]]),
    });
  },
);

test.each([
  ["a terminal load failure", list("load-failed", "terminal")],
  ["a list with no edition", list("not-loaded")],
  ["a stale list", list("stale")],
])(
  "%s settles startup at once and is reported unavailable",
  async (_label, outcome) => {
    let calls = 0;
    const warmup = createSanctionsStartupWarmup({
      screen: async () => {
        calls++;
        return await screened(outcome);
      },
      now: () => 0,
      sleep: async () => undefined,
      terminalize: () => undefined,
      boundMs: 10,
    });

    warmup.start();
    await warmup.settled();

    expect(calls).toBe(1);
    expect(warmup.status()).toEqual({
      status: "terminal",
      reason: "settled",
      lists: new Map([["eu", "unavailable"]]),
    });
  },
);

test("a failed or rejecting screen is captured and retried until it settles", async () => {
  let instant = 0;
  let calls = 0;
  const warmup = createSanctionsStartupWarmup({
    screen: async () => {
      calls++;
      if (calls === 1) {
        return Result.err(new Error("temporary screening failure"));
      }
      if (calls === 2) {
        return await Promise.reject(new Error("screening rejected"));
      }
      return await screened(list(null));
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

  expect(calls).toBe(3);
  expect(warmup.status()).toMatchObject({
    status: "terminal",
    reason: "settled",
  });
});

test("the bound terminalizes the matcher state used by public screening", async () => {
  let instant = 0;
  // Widened so the closures' writes are not narrowed away.
  let loaderState = "warming" as LoaderState;
  const warmup = createSanctionsStartupWarmup({
    screen: async () =>
      await screened(
        list(
          loaderState === "terminal" ? "load-failed" : "warming",
          loaderState,
        ),
      ),
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
