import { expect, test } from "bun:test";

import {
  clampSharedPoolTimeout,
  resolveSharedPoolTimeoutPolicy,
} from "@/api/db/shared-pool-timeout-policy";

test.each([
  { idle: 0, requested: 0, cap: null, effective: null, margin: null },
  { idle: 0, requested: 75_000, cap: null, effective: 75_000, margin: null },
  { idle: 1, requested: 0, cap: 500, effective: 500, margin: 500 },
  { idle: 30, requested: 0, cap: 20_000, effective: 20_000, margin: 10_000 },
  { idle: 30, requested: 3000, cap: 20_000, effective: 3000, margin: 10_000 },
  {
    idle: 30,
    requested: 90_000,
    cap: 20_000,
    effective: 20_000,
    margin: 10_000,
  },
  { idle: 60, requested: 0, cap: 50_000, effective: 50_000, margin: 10_000 },
  { idle: 120, requested: 0, cap: 110_000, effective: 110_000, margin: 10_000 },
])(
  "the shared pool with $idle second idle and $requested ms request uses $effective ms",
  ({ idle, requested, cap, effective, margin }) => {
    const policy = resolveSharedPoolTimeoutPolicy({
      idleTimeoutSeconds: idle,
      requestedStatementTimeoutMs: requested,
    });
    expect(policy).toMatchObject({
      idleTimeoutMs: idle * 1000,
      capMs: cap,
      effectiveStatementTimeoutMs: effective,
      marginMs: margin,
      clamped: cap !== null && requested > cap,
    });
    if (idle > 0) {
      expect(policy.effectiveStatementTimeoutMs).toBeGreaterThan(0);
      expect(policy.effectiveStatementTimeoutMs).toBeLessThan(
        policy.idleTimeoutMs,
      );
    }
  },
);

test("all shared overrides remain within the configured budget", () => {
  for (const idleTimeoutSeconds of [1, 30, 60, 120]) {
    for (const requestedStatementTimeoutMs of [0, 3000, 200_000]) {
      const policy = resolveSharedPoolTimeoutPolicy({
        idleTimeoutSeconds,
        requestedStatementTimeoutMs,
      });
      for (const override of [1, 1000, 30_000, 1_800_000]) {
        expect(clampSharedPoolTimeout(override, policy)).toBeLessThan(
          policy.idleTimeoutMs,
        );
      }
    }
  }
});

test("disabled idle timeout retains existing explicit override behavior", () => {
  const policy = resolveSharedPoolTimeoutPolicy({
    idleTimeoutSeconds: 0,
    requestedStatementTimeoutMs: 3000,
  });
  expect(clampSharedPoolTimeout(60_000, policy)).toBe(60_000);
});

test("unrepresentable config and disabling shared overrides fail", () => {
  expect(() =>
    resolveSharedPoolTimeoutPolicy({
      idleTimeoutSeconds: Number.MAX_SAFE_INTEGER,
      requestedStatementTimeoutMs: 0,
    }),
  ).toThrow("nonnegative safe integers");
  expect(() =>
    clampSharedPoolTimeout(
      0,
      resolveSharedPoolTimeoutPolicy({
        idleTimeoutSeconds: 120,
        requestedStatementTimeoutMs: 0,
      }),
    ),
  ).toThrow("positive safe integer");
});
