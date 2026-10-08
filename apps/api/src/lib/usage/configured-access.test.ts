import { describe, expect, test } from "bun:test";

import {
  FREE_TIER_OFF,
  resolveOrganizationAccess,
} from "@/api/lib/usage/organization-access";
import { allowsInstanceModels } from "@/api/lib/usage/organization-access-state";
import { resolveOrganizationActionBudget } from "@/api/lib/usage/organization-action-budget";

import {
  CONFIGURED_ACCESS_STATE,
  configuredPaymentRetry,
  transitionConfiguredAccess,
  type ConfiguredAccess,
} from "./configured-access";

const START = new Date("2026-06-01T00:00:00Z");
const END = new Date(START.getTime() + 67_000);
const PROFILE = 17;
const RETRY_MS = 13_000;
const active = {
  status: "active",
  periodEndsAt: END,
  serviceActionsPerPeriod: PROFILE,
} as const satisfies ConfiguredAccess;
const accessAt = (configuredAccess: ConfiguredAccess, now: Date) =>
  resolveOrganizationAccess({
    snapshot: {
      state: CONFIGURED_ACCESS_STATE,
      configuredAccess,
      original: undefined,
    },
    now,
    freeTier: FREE_TIER_OFF,
  });
const budget = (configuredAccess: ConfiguredAccess, now: Date) =>
  resolveOrganizationActionBudget({
    access: accessAt(configuredAccess, now),
    periodMs: 23_000,
    evaluationActions: 7,
    selfManagedActions: 19,
  });

const expectAccess = (
  access: ConfiguredAccess,
  now: Date,
  enabled: boolean,
) => {
  expect(allowsInstanceModels(accessAt(access, now))).toBe(enabled);
  const resolved = budget(access, now);
  expect(resolved.status).toBe(enabled ? "resolved" : "not_enabled");
  if (resolved.status === "resolved") {
    expect(resolved.policy.limit).toBe(PROFILE);
  }
};

describe("configured access boundaries", () => {
  test("cancellation uses the stored period end, exclusively", () => {
    const access = transitionConfiguredAccess(active, { type: "cancel" });
    expect(access.status).toBe("ending");
    for (const delta of [-1, 0, 1]) {
      expectAccess(access, new Date(END.getTime() + delta), delta < 0);
    }
    expect(transitionConfiguredAccess(access, { type: "cancel" })).toEqual(
      access,
    );
  });

  test("retry deadline is exclusive, survives repeats and expires the notice", () => {
    const event = {
      type: "payment_retry",
      occurredAt: START,
      retryWindowMs: RETRY_MS,
      cancelAtPeriodEnd: false,
    } as const;
    const access = transitionConfiguredAccess(active, event);
    expect(access.status).toBe("payment_retry");
    const end = START.getTime() + RETRY_MS;
    for (const delta of [-1, 0, 1]) {
      const now = new Date(end + delta);
      expectAccess(access, now, delta < 0);
      expect(configuredPaymentRetry(access, now)).toEqual(
        delta < 0
          ? { status: "payment_retry", endsAt: new Date(end).toISOString() }
          : { status: "none" },
      );
    }
    expect(
      transitionConfiguredAccess(access, {
        ...event,
        occurredAt: new Date(end + 1),
      }),
    ).toEqual(access);
  });

  test("recovery clears the notice and a later failure opens a new window", () => {
    const first = transitionConfiguredAccess(active, {
      type: "payment_retry",
      occurredAt: START,
      retryWindowMs: RETRY_MS,
      cancelAtPeriodEnd: false,
    });
    const recovered = transitionConfiguredAccess(first, {
      type: "active",
      periodEndsAt: END,
      serviceActionsPerPeriod: PROFILE,
      cancelAtPeriodEnd: false,
    });
    expect(configuredPaymentRetry(recovered, START)).toEqual({
      status: "none",
    });
    const later = new Date(START.getTime() + 5000);
    const next = transitionConfiguredAccess(recovered, {
      type: "payment_retry",
      occurredAt: later,
      retryWindowMs: RETRY_MS,
      cancelAtPeriodEnd: false,
    });
    expect(configuredPaymentRetry(next, later)).toEqual({
      status: "payment_retry",
      endsAt: new Date(later.getTime() + RETRY_MS).toISOString(),
    });
    expectAccess(next, new Date(START.getTime() + RETRY_MS), true);
  });

  test("revocation denies immediately from every lifecycle state", () => {
    const states = [
      active,
      transitionConfiguredAccess(active, { type: "cancel" }),
      transitionConfiguredAccess(active, {
        type: "payment_retry",
        occurredAt: START,
        retryWindowMs: RETRY_MS,
        cancelAtPeriodEnd: false,
      }),
      { status: "disabled" } as const,
      null,
    ];
    for (const current of states) {
      const denied = transitionConfiguredAccess(current, { type: "deny" });
      expectAccess(denied, START, false);
      expect(transitionConfiguredAccess(denied, { type: "cancel" })).toEqual(
        denied,
      );
      expect(
        transitionConfiguredAccess(denied, {
          type: "payment_retry",
          occurredAt: START,
          retryWindowMs: RETRY_MS,
          cancelAtPeriodEnd: false,
        }),
      ).toEqual(denied);
    }
  });

  test("combining cancellation and retry cannot extend either deadline", () => {
    const ending = transitionConfiguredAccess(active, { type: "cancel" });
    const retry = transitionConfiguredAccess(ending, {
      type: "payment_retry",
      occurredAt: new Date(END.getTime() - 1),
      retryWindowMs: RETRY_MS,
      cancelAtPeriodEnd: false,
    });
    expectAccess(retry, END, false);
    const firstRetry = transitionConfiguredAccess(active, {
      type: "payment_retry",
      occurredAt: START,
      retryWindowMs: RETRY_MS,
      cancelAtPeriodEnd: false,
    });
    const cancelled = transitionConfiguredAccess(firstRetry, {
      type: "cancel",
    });
    expectAccess(cancelled, new Date(START.getTime() + RETRY_MS), false);
  });

  test("missing profile cannot grant configured access", () => {
    expectAccess(
      transitionConfiguredAccess(active, {
        type: "active",
        periodEndsAt: END,
        serviceActionsPerPeriod: null,
        cancelAtPeriodEnd: false,
      }),
      START,
      false,
    );
  });
  test("scheduled activation preserves stored terms and uncancellation accepts new terms", () => {
    const renewedEnd = new Date(END.getTime() + 32_000);
    const renewedProfile = PROFILE + 14;
    const scheduled = transitionConfiguredAccess(active, {
      type: "active",
      periodEndsAt: renewedEnd,
      serviceActionsPerPeriod: renewedProfile,
      cancelAtPeriodEnd: true,
    });
    expect(scheduled).toEqual({
      status: "ending",
      periodEndsAt: END,
      serviceActionsPerPeriod: PROFILE,
    });
    expectAccess(scheduled, new Date(END.getTime() - 1), true);
    expectAccess(scheduled, END, false);
    const renewed = transitionConfiguredAccess(scheduled, {
      type: "active",
      periodEndsAt: renewedEnd,
      serviceActionsPerPeriod: renewedProfile,
      cancelAtPeriodEnd: false,
    });
    expect(renewed).toEqual({
      status: "active",
      periodEndsAt: renewedEnd,
      serviceActionsPerPeriod: renewedProfile,
    });
    expect(budget(renewed, END)).toEqual({
      status: "resolved",
      policy: { periodMs: 23_000, limit: renewedProfile },
      scope: { type: "per_kind" },
      serviceDeadlineMs: renewedEnd.getTime(),
    });
    expectAccess(renewed, renewedEnd, false);
  });
});
