import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { ORGANIZATION_ACCESS_STATE } from "@/api/db/schema";
import {
  ACTION_KINDS,
  ACTION_SERVICE_CREDENTIALS,
  type ActionKind,
} from "@/api/lib/rate-limit/action-kinds";
import type { ActionPeriodScope } from "@/api/lib/rate-limit/action-period-budget";
import {
  CONFIGURED_ACCESS_STATE,
  CONFIGURED_ACCESS_STATUSES,
  type ConfiguredAccess,
} from "@/api/lib/usage/configured-access";
import {
  resolveOrganizationAccess,
  type FreeTier,
  type OrganizationAccessType,
} from "@/api/lib/usage/organization-access";
import type {
  OrganizationAccessSnapshot,
  OriginalOrganizationAccessSnapshot,
} from "@/api/lib/usage/organization-access-snapshot";
import { allowsInstanceModels } from "@/api/lib/usage/organization-access-state";
import {
  actionDrawsServiceBudget,
  ORGANIZATION_MODEL_CREDENTIALS,
  resolveOrganizationActionBudget,
} from "@/api/lib/usage/organization-action-budget";

const NOW_MS = Date.UTC(2026, 9, 5, 12);
const NOW = new Date(NOW_MS);
const PAID_ACTIONS = 41;
const FREE_ACTIONS = 3;
const CONFIG = {
  periodMs: 2_592_000_000,
  evaluationActions: 7,
  selfManagedActions: 19,
};

// Where a deadline sits relative to now. A deadline equal to now has passed.
const POSITIONS = ["before_now", "at_now", "after_now"] as const;
type Position = (typeof POSITIONS)[number];
const DEADLINE_MS_BY_POSITION = {
  before_now: NOW_MS - 1,
  at_now: NOW_MS,
  after_now: NOW_MS + 1,
} as const satisfies Record<Position, number>;
const deadlineAt = (position: Position) =>
  new Date(DEADLINE_MS_BY_POSITION[position]);
const LIVE_BY_POSITION = {
  before_now: false,
  at_now: false,
  after_now: true,
} as const satisfies Record<Position, boolean>;

type OriginalCase =
  | { type: "missing" }
  | { type: "self_managed_keys" }
  | { type: "evaluation_period"; position: Position }
  | { type: "evaluation_ended" };

type OverlayCase =
  | { type: "none" }
  | {
      type: "configured";
      status: (typeof CONFIGURED_ACCESS_STATUSES)[number];
      position: Position;
    };

type FreeTierCase = "off" | "on_missing" | "on";

const originalArb = fc.oneof(
  fc.constant({ type: "missing" } as const),
  fc.constant({ type: "self_managed_keys" } as const),
  fc.record({
    type: fc.constant("evaluation_period" as const),
    position: fc.constantFrom(...POSITIONS),
  }),
  fc.constant({ type: "evaluation_ended" } as const),
) satisfies fc.Arbitrary<OriginalCase>;

const overlayArb = fc.oneof(
  fc.constant({ type: "none" } as const),
  fc.record({
    type: fc.constant("configured" as const),
    status: fc.constantFrom(...CONFIGURED_ACCESS_STATUSES),
    position: fc.constantFrom(...POSITIONS),
  }),
) satisfies fc.Arbitrary<OverlayCase>;

const freeTierArb = fc.constantFrom<FreeTierCase>("off", "on_missing", "on");

const buildOriginal = (
  original: OriginalCase,
): OriginalOrganizationAccessSnapshot | undefined => {
  switch (original.type) {
    case "missing":
      return undefined;
    case "self_managed_keys":
      return {
        state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
        evaluationEndsAt: null,
      };
    case "evaluation_period":
      return {
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        evaluationEndsAt: deadlineAt(original.position),
      };
    case "evaluation_ended":
      return {
        state: ORGANIZATION_ACCESS_STATE.evaluationEnded,
        evaluationEndsAt: new Date(NOW_MS - 86_400_000),
      };
    default:
      original satisfies never;
      throw new Error("unreachable original case");
  }
};

const buildConfigured = (
  overlay: Extract<OverlayCase, { type: "configured" }>,
): ConfiguredAccess => {
  const deadline = deadlineAt(overlay.position);
  switch (overlay.status) {
    case "active":
    case "ending":
      return {
        status: overlay.status,
        periodEndsAt: deadline,
        serviceActionsPerPeriod: PAID_ACTIONS,
      };
    case "payment_retry":
      return {
        status: "payment_retry",
        periodEndsAt: new Date(NOW_MS + 86_400_000),
        retryEndsAt: deadline,
        serviceActionsPerPeriod: PAID_ACTIONS,
      };
    case "disabled":
      return { status: "disabled" };
    default:
      overlay.status satisfies never;
      throw new Error("unreachable configured status");
  }
};

const buildSnapshot = (
  original: OriginalCase,
  overlay: OverlayCase,
): OrganizationAccessSnapshot | undefined => {
  if (overlay.type === "none") {
    return buildOriginal(original);
  }
  return {
    state: CONFIGURED_ACCESS_STATE,
    configuredAccess: buildConfigured(overlay),
    original: buildOriginal(original),
  };
};

const buildFreeTier = (freeTier: FreeTierCase): FreeTier => {
  switch (freeTier) {
    case "off":
      return { status: "off" };
    case "on_missing":
      return { status: "on", policy: undefined };
    case "on":
      return {
        status: "on",
        policy: { serviceActionsPerPeriod: FREE_ACTIONS },
      };
    default:
      freeTier satisfies never;
      throw new Error("unreachable free tier case");
  }
};

// The independent oracle: what each lapsed standing becomes per free tier.
const LAPSED_BY_FREE_TIER = {
  off: "ended",
  on_missing: "unavailable",
  on: "free",
} as const satisfies Record<FreeTierCase, OrganizationAccessType>;

const CONFIGURED_STATUS_GRANTS = {
  active: true,
  ending: true,
  payment_retry: true,
  disabled: false,
} as const satisfies Record<
  (typeof CONFIGURED_ACCESS_STATUSES)[number],
  boolean
>;

const expectedStanding = (
  original: OriginalCase,
  freeTier: FreeTierCase,
): OrganizationAccessType => {
  switch (original.type) {
    case "missing":
      return "unavailable";
    case "self_managed_keys":
      return "self_managed_keys";
    case "evaluation_period":
      return LIVE_BY_POSITION[original.position]
        ? "evaluation"
        : LAPSED_BY_FREE_TIER[freeTier];
    case "evaluation_ended":
      return LAPSED_BY_FREE_TIER[freeTier];
    default:
      original satisfies never;
      throw new Error("unreachable original case");
  }
};

const expectedAccess = (
  original: OriginalCase,
  overlay: OverlayCase,
  freeTier: FreeTierCase,
): OrganizationAccessType => {
  if (overlay.type === "none") {
    return expectedStanding(original, freeTier);
  }
  if (
    CONFIGURED_STATUS_GRANTS[overlay.status] &&
    LIVE_BY_POSITION[overlay.position]
  ) {
    return "paid";
  }
  // Lapsed paid access ends with the flag off; with it on, the standing
  // recorded before the paid access applies again.
  return freeTier === "off" ? "ended" : expectedStanding(original, freeTier);
};

const INSTANCE_MODELS_BY_ACCESS = {
  paid: true,
  evaluation: true,
  free: true,
  self_managed_keys: false,
  ended: false,
  unavailable: false,
} as const satisfies Record<OrganizationAccessType, boolean>;

// Free is one count across every kind; every other standing counts per kind.
const BUDGET_BY_ACCESS = {
  paid: {
    status: "resolved",
    limit: PAID_ACTIONS,
    scope: { type: "per_kind" },
  },
  evaluation: {
    status: "resolved",
    limit: CONFIG.evaluationActions,
    scope: { type: "per_kind" },
  },
  free: {
    status: "resolved",
    limit: FREE_ACTIONS,
    scope: { type: "pooled", poolKey: "free" },
  },
  self_managed_keys: {
    status: "resolved",
    limit: CONFIG.selfManagedActions,
    scope: { type: "per_kind" },
  },
  ended: { status: "not_enabled" },
  unavailable: { status: "unavailable" },
} as const satisfies Record<
  OrganizationAccessType,
  | { status: "resolved"; limit: number; scope: ActionPeriodScope }
  | { status: "not_enabled" | "unavailable" }
>;

describe("organization access resolution", () => {
  test("every access state, configured status, deadline position and free tier resolves to the oracle's standing", () => {
    assertProperty(
      "every access state, configured status, deadline position and free tier resolves to the oracle's standing",
      fc.property(
        originalArb,
        overlayArb,
        freeTierArb,
        (original, overlay, freeTier) => {
          const access = resolveOrganizationAccess({
            snapshot: buildSnapshot(original, overlay),
            now: NOW,
            freeTier: buildFreeTier(freeTier),
          });
          const expected = expectedAccess(original, overlay, freeTier);
          expect(access.type).toBe(expected);
          expect(allowsInstanceModels(access)).toBe(
            INSTANCE_MODELS_BY_ACCESS[expected],
          );
          const budget = resolveOrganizationActionBudget({
            access,
            ...CONFIG,
          });
          const expectedBudget = BUDGET_BY_ACCESS[expected];
          expect(budget.status).toBe(expectedBudget.status);
          if (
            budget.status === "resolved" &&
            expectedBudget.status === "resolved"
          ) {
            expect(budget.policy).toEqual({
              periodMs: CONFIG.periodMs,
              limit: expectedBudget.limit,
            });
            expect(budget.scope).toEqual(expectedBudget.scope);
            // Only time-boxed standings carry a service deadline.
            expect(budget.serviceDeadlineMs === null).toBe(
              expected === "free" || expected === "self_managed_keys",
            );
          }
        },
      ),
    );
  });

  test("the free tier off reproduces the standing without a free floor", () => {
    assertProperty(
      "the free tier off reproduces the standing without a free floor",
      fc.property(originalArb, overlayArb, (original, overlay) => {
        const access = resolveOrganizationAccess({
          snapshot: buildSnapshot(original, overlay),
          now: NOW,
          freeTier: { status: "off" },
        });
        expect(access.type).not.toBe("free");
      }),
    );
  });
});

const MODEL_CREDENTIALS = Object.values(ORGANIZATION_MODEL_CREDENTIALS);
const ACCESS_TYPES = Object.keys(INSTANCE_MODELS_BY_ACCESS).filter(
  (type): type is OrganizationAccessType =>
    Object.hasOwn(INSTANCE_MODELS_BY_ACCESS, type),
);
const ACTION_KIND_NAMES = Object.keys(ACTION_KINDS).filter(
  (kind): kind is ActionKind => Object.hasOwn(ACTION_KINDS, kind),
);

const accessOfType = (accessType: OrganizationAccessType) => {
  switch (accessType) {
    case "paid":
      return {
        type: accessType,
        deadline: deadlineAt("after_now"),
        serviceActionsPerPeriod: PAID_ACTIONS,
      } as const;
    case "evaluation":
      return { type: accessType, endsAt: deadlineAt("after_now") } as const;
    case "free":
      return {
        type: accessType,
        serviceActionsPerPeriod: FREE_ACTIONS,
      } as const;
    case "self_managed_keys":
    case "ended":
    case "unavailable":
      return { type: accessType } as const;
    default:
      accessType satisfies never;
      throw new Error("unreachable access type");
  }
};

describe("which actions draw the service budget", () => {
  test("every standing, action kind and model key draws the budget except free-floor model work on the organization's own key", () => {
    for (const type of ACCESS_TYPES) {
      for (const actionKind of ACTION_KIND_NAMES) {
        for (const modelCredentials of MODEL_CREDENTIALS) {
          const { serviceCredentials } = ACTION_KINDS[actionKind];
          const ownKeyServes =
            serviceCredentials ===
              ACTION_SERVICE_CREDENTIALS.organizationModel &&
            modelCredentials === ORGANIZATION_MODEL_CREDENTIALS.organization;
          expect(
            actionDrawsServiceBudget({
              access: accessOfType(type),
              serviceCredentials,
              modelCredentials,
            }),
          ).toBe(!(type === "free" && ownKeyServes));
        }
      }
    }
  });

  test("managed services stay counted on the free floor with the organization's own key", () => {
    const managed = ACTION_KIND_NAMES.filter(
      (kind) =>
        ACTION_KINDS[kind].serviceCredentials ===
        ACTION_SERVICE_CREDENTIALS.managedService,
    );
    expect(managed).toContain("mcp.services/call");
    for (const actionKind of managed) {
      expect(
        actionDrawsServiceBudget({
          access: accessOfType("free"),
          serviceCredentials: ACTION_KINDS[actionKind].serviceCredentials,
          modelCredentials: ORGANIZATION_MODEL_CREDENTIALS.organization,
        }),
      ).toBe(true);
    }
  });
});
