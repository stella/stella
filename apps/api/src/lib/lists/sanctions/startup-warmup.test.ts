import { expect, test } from "bun:test";

import { createSanctionsStartupWarmup } from "@/api/lib/lists/sanctions/startup-warmup";

const list = (reason: "warming" | "load-failed" | null) => ({
  source: "eu" as const,
  reason,
});

test("a list stuck warming becomes a named terminal failure at the bound", async () => {
  let instant = 0;
  const warmup = createSanctionsStartupWarmup({
    screen: async () => [list("warming")],
    now: () => instant,
    sleep: async () => {
      instant = 100;
    },
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
