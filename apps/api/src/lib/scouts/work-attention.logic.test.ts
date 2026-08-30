import { describe, expect, test } from "bun:test";

import { SIGNAL_KIND, SUGGESTION_KIND } from "@stll/api-contract/signals";
import { WORK_OBLIGATION_STATUS } from "@stll/api-contract/workflow-status";

import { createSafeId } from "@/api/lib/branded-types";
import {
  daysUntilDate,
  daysWaitingSince,
  deadlineAtRiskDedupeKey,
  deadlineAtRiskSeverity,
  unacknowledgedDedupeKey,
  WORK_ATTENTION_ACKNOWLEDGEMENT_DAYS,
  WORK_ATTENTION_DEADLINE_DAYS,
  workAttentionSignals,
} from "@/api/lib/scouts/work-attention.logic";
import type { WorkAttentionObligation } from "@/api/lib/scouts/work-attention.logic";

const NOW = new Date("2026-03-01T09:00:00.000Z");
const ENTITY_ID = createSafeId<"entity">();
const WORKSPACE_ID = createSafeId<"workspace">();
const OWNER_ID = createSafeId<"user">();

const daysBefore = (days: number): Date =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

const obligation = (
  overrides: Partial<WorkAttentionObligation> = {},
): WorkAttentionObligation => ({
  entityId: ENTITY_ID,
  workspaceId: WORKSPACE_ID,
  name: "File the appeal",
  status: WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
  ownerUserId: OWNER_ID,
  assignedAt: daysBefore(0),
  workingTargetDate: null,
  hardDeadlineDate: null,
  ...overrides,
});

const kinds = (signals: readonly { kind: string }[]) =>
  signals.map(({ kind }) => kind);

describe("daysWaitingSince", () => {
  test("counts whole days only, so a partial day never crosses the threshold", () => {
    expect(daysWaitingSince(daysBefore(3), NOW)).toBe(3);
    expect(
      daysWaitingSince(new Date(daysBefore(3).getTime() + 60_000), NOW),
    ).toBe(2);
  });
});

describe("daysUntilDate", () => {
  test("compares civil dates, not instants", () => {
    // Late in the UTC day: an instant subtraction would report 0.02 days and
    // round the next morning's deadline into today.
    const lateInTheDay = new Date("2026-03-01T23:30:00.000Z");
    expect(daysUntilDate("2026-03-02", lateInTheDay)).toBe(1);
    expect(daysUntilDate("2026-03-01", lateInTheDay)).toBe(0);
    expect(daysUntilDate("2026-02-28", lateInTheDay)).toBe(-1);
  });

  test("crosses a month boundary", () => {
    expect(
      daysUntilDate("2026-03-03", new Date("2026-02-28T09:00:00.000Z")),
    ).toBe(3);
  });
});

describe("deadlineAtRiskSeverity", () => {
  test("today still warns; only a passed deadline is critical", () => {
    expect(deadlineAtRiskSeverity(WORK_ATTENTION_DEADLINE_DAYS)).toBe(
      "warning",
    );
    expect(deadlineAtRiskSeverity(0)).toBe("warning");
    expect(deadlineAtRiskSeverity(-1)).toBe("critical");
  });
});

describe("workAttentionSignals", () => {
  test("an assignment answered within the window emits nothing", () => {
    expect(
      workAttentionSignals(
        obligation({
          assignedAt: daysBefore(WORK_ATTENTION_ACKNOWLEDGEMENT_DAYS - 1),
        }),
        NOW,
      ),
    ).toEqual([]);
  });

  test("the acknowledgement threshold is inclusive", () => {
    const signals = workAttentionSignals(
      obligation({
        assignedAt: daysBefore(WORK_ATTENTION_ACKNOWLEDGEMENT_DAYS),
      }),
      NOW,
    );

    expect(kinds(signals)).toEqual([SIGNAL_KIND.WORK_UNACKNOWLEDGED]);
    const [signal] = signals;
    expect(signal?.severity).toBe("warning");
    expect(signal?.confidence).toBeNull();
    expect(signal?.workspaceId).toBe(WORKSPACE_ID);
    expect(signal?.subject).toEqual({
      type: "entity",
      workspaceId: WORKSPACE_ID,
      entityId: ENTITY_ID,
    });
    expect(signal?.suggestions).toEqual([{ kind: SUGGESTION_KIND.ASSIGN }]);
    expect(signal?.evidence).toEqual({
      kind: SIGNAL_KIND.WORK_UNACKNOWLEDGED,
      obligationEntityId: ENTITY_ID,
      ownerUserId: OWNER_ID,
      assignedAt: daysBefore(WORK_ATTENTION_ACKNOWLEDGEMENT_DAYS).toISOString(),
      daysWaiting: WORK_ATTENTION_ACKNOWLEDGEMENT_DAYS,
      workingTargetDate: null,
      hardDeadlineDate: null,
    });
  });

  test("an acknowledged obligation is never unacknowledged, however old", () => {
    expect(
      workAttentionSignals(
        obligation({
          status: WORK_OBLIGATION_STATUS.ACTIVE,
          assignedAt: daysBefore(90),
        }),
        NOW,
      ),
    ).toEqual([]);
  });

  test("a deadline outside the window is not at risk, the boundary one is", () => {
    expect(
      workAttentionSignals(
        obligation({
          status: WORK_OBLIGATION_STATUS.ACTIVE,
          hardDeadlineDate: "2026-03-05",
        }),
        NOW,
      ),
    ).toEqual([]);

    const signals = workAttentionSignals(
      obligation({
        status: WORK_OBLIGATION_STATUS.ACTIVE,
        hardDeadlineDate: "2026-03-04",
        workingTargetDate: "2026-03-02",
      }),
      NOW,
    );
    expect(kinds(signals)).toEqual([SIGNAL_KIND.WORK_DEADLINE_AT_RISK]);
    expect(signals.at(0)?.severity).toBe("warning");
    expect(signals.at(0)?.evidence).toEqual({
      kind: SIGNAL_KIND.WORK_DEADLINE_AT_RISK,
      obligationEntityId: ENTITY_ID,
      ownerUserId: OWNER_ID,
      hardDeadlineDate: "2026-03-04",
      workingTargetDate: "2026-03-02",
      daysUntilDeadline: WORK_ATTENTION_DEADLINE_DAYS,
      obligationStatus: WORK_OBLIGATION_STATUS.ACTIVE,
    });
  });

  test("a passed deadline is critical and reports negative days", () => {
    const signals = workAttentionSignals(
      obligation({
        status: WORK_OBLIGATION_STATUS.ACTIVE,
        hardDeadlineDate: "2026-02-25",
      }),
      NOW,
    );

    expect(signals.at(0)?.severity).toBe("critical");
    expect(signals.at(0)?.evidence).toMatchObject({ daysUntilDeadline: -4 });
  });

  test("an unanswered assignment with a closing deadline raises both", () => {
    const signals = workAttentionSignals(
      obligation({
        assignedAt: daysBefore(10),
        hardDeadlineDate: "2026-03-01",
      }),
      NOW,
    );

    expect(kinds(signals)).toEqual([
      SIGNAL_KIND.WORK_UNACKNOWLEDGED,
      SIGNAL_KIND.WORK_DEADLINE_AT_RISK,
    ]);
  });
});

describe("dedupe keys", () => {
  test("the same waiting state repeats, a reassignment does not", () => {
    const assignedAt = daysBefore(5);
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    const first = workAttentionSignals(obligation({ assignedAt }), NOW);
    const second = workAttentionSignals(obligation({ assignedAt }), later);

    expect(first.at(0)?.dedupeKey).toBe(second.at(0)?.dedupeKey ?? "");
    expect(first.at(0)?.dedupeKey).toBe(
      unacknowledgedDedupeKey(ENTITY_ID, assignedAt),
    );
    expect(unacknowledgedDedupeKey(ENTITY_ID, daysBefore(4))).not.toBe(
      unacknowledgedDedupeKey(ENTITY_ID, assignedAt),
    );
  });

  test("a moved hard deadline is a new observation", () => {
    const atRisk = (hardDeadlineDate: string) =>
      workAttentionSignals(
        obligation({
          status: WORK_OBLIGATION_STATUS.ACTIVE,
          hardDeadlineDate,
        }),
        NOW,
      ).at(0)?.dedupeKey;

    expect(atRisk("2026-03-02")).toBe(
      deadlineAtRiskDedupeKey(ENTITY_ID, "2026-03-02"),
    );
    expect(atRisk("2026-03-02")).not.toBe(atRisk("2026-03-03"));
  });

  test("the two kinds never share a key for one obligation", () => {
    const signals = workAttentionSignals(
      obligation({ assignedAt: daysBefore(5), hardDeadlineDate: "2026-03-02" }),
      NOW,
    );

    expect(new Set(signals.map(({ dedupeKey }) => dedupeKey)).size).toBe(2);
  });
});
