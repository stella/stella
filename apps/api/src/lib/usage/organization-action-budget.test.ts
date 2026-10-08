import { describe, expect, test } from "bun:test";

import { ORGANIZATION_ACCESS_STATE } from "@/api/db/schema";

import {
  FREE_TIER_OFF,
  resolveOrganizationAccess,
} from "./organization-access";
import type { OrganizationAccessSnapshot } from "./organization-access-snapshot";
import {
  resolveOrganizationActionBudget,
  type OrganizationActionBudgetConfig,
} from "./organization-action-budget";

const expiresAtMs = Date.UTC(2026, 9, 1, 12, 30);
const PER_KIND = { type: "per_kind" } as const;
type ResolveOverrides = Partial<
  OrganizationActionBudgetConfig & {
    state: OrganizationAccessSnapshot | undefined;
    now: Date;
  }
>;
const resolve = (overrides: ResolveOverrides = {}) => {
  const { state, now, ...config } = {
    state: {
      state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
      evaluationEndsAt: new Date(expiresAtMs),
    },
    now: new Date(expiresAtMs - 1),
    periodMs: 86_400_000,
    evaluationActions: 7,
    selfManagedActions: 19,
    ...overrides,
  };
  return resolveOrganizationActionBudget({
    access: resolveOrganizationAccess({
      snapshot: state,
      now,
      freeTier: FREE_TIER_OFF,
    }),
    ...config,
  });
};

describe("organization service action budgets", () => {
  test("selects the configured budget for each enabled access state", () => {
    for (const periodMs of [1, 3_600_000, 86_400_000]) {
      for (const evaluationActions of [1, 13, 2047]) {
        for (const selfManagedActions of [2, 31, 8191]) {
          const config = { periodMs, evaluationActions, selfManagedActions };
          expect(resolve(config)).toEqual({
            status: "resolved",
            policy: { periodMs, limit: evaluationActions },
            scope: PER_KIND,
            serviceDeadlineMs: expiresAtMs,
          });
          expect(
            resolve({
              ...config,
              state: {
                state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
                evaluationEndsAt: null,
              },
            }),
          ).toEqual({
            status: "resolved",
            policy: { periodMs, limit: selfManagedActions },
            scope: PER_KIND,
            serviceDeadlineMs: null,
          });
        }
      }
    }
  });

  test("refuses evaluation actions exactly at the explicit UTC expiry", () => {
    expect(resolve({ now: new Date(expiresAtMs - 1) })).toEqual({
      status: "resolved",
      policy: { periodMs: 86_400_000, limit: 7 },
      scope: PER_KIND,
      serviceDeadlineMs: expiresAtMs,
    });
    for (const nowMs of [expiresAtMs, expiresAtMs + 1]) {
      expect(resolve({ now: new Date(nowMs) })).toEqual({
        status: "not_enabled",
      });
    }
  });

  test("refuses ended evaluations and evaluations without an expiry", () => {
    for (const state of [
      {
        state: ORGANIZATION_ACCESS_STATE.evaluationEnded,
        evaluationEndsAt: new Date(expiresAtMs),
      },
      {
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        evaluationEndsAt: null,
      },
    ]) {
      expect(resolve({ state })).toEqual({ status: "not_enabled" });
    }
  });

  test("fails closed when state or the selected operator configuration is missing", () => {
    expect(resolve({ state: undefined })).toEqual({ status: "unavailable" });
    expect(resolve({ periodMs: undefined })).toEqual({ status: "unavailable" });
    expect(resolve({ evaluationActions: undefined })).toEqual({
      status: "unavailable",
    });
    expect(
      resolve({
        state: {
          state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
          evaluationEndsAt: null,
        },
        selfManagedActions: undefined,
      }),
    ).toEqual({ status: "unavailable" });
  });

  test("fails closed for every invalid selected budget or period", () => {
    for (const invalid of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(resolve({ periodMs: invalid })).toEqual({ status: "unavailable" });
      expect(resolve({ evaluationActions: invalid })).toEqual({
        status: "unavailable",
      });
      expect(
        resolve({
          state: {
            state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
            evaluationEndsAt: null,
          },
          selfManagedActions: invalid,
        }),
      ).toEqual({ status: "unavailable" });
    }
  });

  test("self-managed actions do not depend on evaluation expiry or configuration", () => {
    for (const evaluationEndsAt of [null, new Date(expiresAtMs - 1)]) {
      for (const evaluationActions of [undefined, 0, Number.NaN]) {
        expect(
          resolve({
            state: {
              state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
              evaluationEndsAt,
            },
            now: new Date(expiresAtMs + 1),
            evaluationActions,
          }),
        ).toEqual({
          status: "resolved",
          policy: { periodMs: 86_400_000, limit: 19 },
          scope: PER_KIND,
          serviceDeadlineMs: null,
        });
      }
    }
    expect(resolve({ selfManagedActions: undefined })).toEqual({
      status: "resolved",
      policy: { periodMs: 86_400_000, limit: 7 },
      scope: PER_KIND,
      serviceDeadlineMs: expiresAtMs,
    });
  });

  test("repeated resolution preserves persisted state and returns the same decision", () => {
    for (const accessState of Object.values(ORGANIZATION_ACCESS_STATE)) {
      for (const nowMs of [expiresAtMs - 1, expiresAtMs, expiresAtMs + 1]) {
        const state = Object.freeze({
          state: accessState,
          evaluationEndsAt: new Date(expiresAtMs),
        });
        const original = structuredClone(state);
        const now = new Date(nowMs);
        const first = resolve({ state, now });
        expect(resolve({ state, now })).toEqual(first);
        expect(state).toEqual(original);
        expect(now.getTime()).toBe(nowMs);
      }
    }
  });
});
