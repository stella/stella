import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  GATED_TEST_FORCE_CLOSE_TIMEOUT_SECONDS,
  withGatedTestClients,
} from "./gated-test-database";

test("invalid close budgets cannot start a client scope", async () => {
  for (const closeTimeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    let started = false;
    const error = await rejectionOf(
      withGatedTestClients(
        "postgres://unused",
        async () => {
          started = true;
        },
        { closeTimeout },
      ),
    );
    expect(error).toMatchObject({
      message:
        "Gated test closeTimeout must be finite and positive; omit it to drain queries",
    });
    expect(started).toBe(false);
  }
});

test("scopes support a positive termination budget or an omitted draining budget", async () => {
  expect(
    await withGatedTestClients("postgres://unused", async () => "bounded", {
      closeTimeout: GATED_TEST_FORCE_CLOSE_TIMEOUT_SECONDS,
    }),
  ).toBe("bounded");
  expect(
    await withGatedTestClients("postgres://unused", async () => "drained"),
  ).toBe("drained");
});
