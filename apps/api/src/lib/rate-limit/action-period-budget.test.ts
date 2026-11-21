import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import {
  PER_KIND_PERIOD_SCOPE,
  resolveActionPeriodBudget,
} from "./action-period-budget";

const organizationId = toSafeId<"organization">("period_org");
const identity = { actionKind: "chat.send", logicalPhaseId: "message:phase" };
const policy = { periodMs: 86_400_000, limit: 3 };
const nowMs = Date.UTC(2026, 8, 30, 12);
const resolve = (
  overrides: Partial<Parameters<typeof resolveActionPeriodBudget>[0]> = {},
) =>
  resolveActionPeriodBudget({
    organizationId,
    identity,
    policy,
    scope: PER_KIND_PERIOD_SCOPE,
    nowMs,
    ...overrides,
  });
const budgetOf = (result: ReturnType<typeof resolve>) => {
  if (Result.isError(result)) {
    throw result.error;
  }
  if (result.value === null) {
    throw new Error("Expected a period budget");
  }
  return result.value;
};

describe("UTC action period identity", () => {
  test("uses one hash per organization, kind and UTC period", () => {
    const budget = budgetOf(resolve());
    expect(budget.startMs).toBe(Date.UTC(2026, 8, 30));
    expect(budget.endMs).toBe(Date.UTC(2026, 9, 1));
    expect(budget.key).toContain("{period_org}");
    const replay = budgetOf(resolve({ nowMs: nowMs + 1 }));
    expect(replay).toEqual(budget);
    const otherPhase = budgetOf(
      resolve({ identity: { ...identity, logicalPhaseId: "another-phase" } }),
    );
    expect(otherPhase.key).toBe(budget.key);
    expect(otherPhase.phaseField).not.toBe(budget.phaseField);
    expect(
      budgetOf(
        resolve({ identity: { ...identity, actionKind: "workflow.start" } }),
      ).key,
    ).not.toBe(budget.key);
    expect(
      budgetOf(
        resolve({ organizationId: toSafeId<"organization">("other_org") }),
      ).key,
    ).not.toBe(budget.key);
  });

  test("different operator window widths cannot share a TTL or count", () => {
    const first = budgetOf(resolve({ nowMs: Date.UTC(2026, 8, 30) }));
    const shorter = budgetOf(
      resolve({
        nowMs: Date.UTC(2026, 8, 30),
        policy: { periodMs: policy.periodMs / 2, limit: policy.limit },
      }),
    );
    expect(shorter.startMs).toBe(first.startMs);
    expect(shorter.endMs).not.toBe(first.endMs);
    expect(shorter.key).not.toBe(first.key);
  });

  test("rolls over exactly at the UTC boundary", () => {
    const budget = budgetOf(resolve());
    expect(budgetOf(resolve({ nowMs: budget.endMs - 1 })).key).toBe(budget.key);
    const next = budgetOf(resolve({ nowMs: budget.endMs }));
    expect(next.startMs).toBe(budget.endMs);
    expect(next.key).not.toBe(budget.key);
  });

  test("fails closed on incomplete identity and invalid operator limits", () => {
    for (const invalid of [
      { identity: undefined },
      { identity: { actionKind: "", logicalPhaseId: "phase" } },
      { identity: { actionKind: "chat.send", logicalPhaseId: "" } },
      { policy: { periodMs: 0, limit: 3 } },
      { policy: { periodMs: 1.5, limit: 3 } },
      { policy: { periodMs: 86_400_000, limit: 0 } },
      { policy: { periodMs: 86_400_000, limit: Number.MAX_SAFE_INTEGER + 1 } },
      { nowMs: Number.NaN },
      { scope: { type: "pooled", poolKey: " " } },
    ] as const) {
      expect(Result.isError(resolve(invalid))).toBe(true);
    }
  });

  test("a pooled scope shares one count across kinds and keeps phases apart", () => {
    const pooled = { type: "pooled", poolKey: "free" } as const;
    const chat = budgetOf(resolve({ scope: pooled }));
    const workflow = budgetOf(
      resolve({
        scope: pooled,
        identity: { ...identity, actionKind: "workflow.start" },
      }),
    );
    expect(workflow.key).toBe(chat.key);
    expect(workflow.phaseField).not.toBe(chat.phaseField);
    expect(chat.scope).toEqual(pooled);
    expect(budgetOf(resolve({ scope: pooled })).phaseField).toBe(
      chat.phaseField,
    );
    expect(chat.key).not.toBe(budgetOf(resolve()).key);
    expect(chat.key).not.toBe(
      budgetOf(resolve({ scope: { type: "pooled", poolKey: "other" } })).key,
    );
    expect(chat.key).not.toBe(
      budgetOf(
        resolve({
          scope: pooled,
          organizationId: toSafeId<"organization">("other_org"),
        }),
      ).key,
    );
  });
});
