import { describe, expect, test } from "bun:test";

import {
  WORK_OBLIGATION_STATUS,
  WORK_OBLIGATION_STATUSES,
} from "@/api/db/schema";
import type { WorkObligationStatus } from "@/api/db/schema";
import { TASK_STATUSES } from "@/api/lib/entity-constants";
import {
  nextWorkObligationStatus,
  reopenedWorkObligationStatus,
  resolveWorkObligationTransition,
  WORK_OBLIGATION_TRANSITION_ACTION,
  WORK_OBLIGATION_TRANSITION_ACTIONS,
  WORK_OBLIGATION_TRANSITIONS,
  workObligationIntentForTaskStatus,
} from "@/api/lib/work-obligations/transitions";

const CLOSED_STATUSES = WORK_OBLIGATION_TRANSITIONS.reopen.from;
const isClosed = (status: WorkObligationStatus) =>
  CLOSED_STATUSES.some((closed) => closed === status);

/** The task statuses that name a lifecycle action outright, read off the table. */
const closingTaskStatuses = WORK_OBLIGATION_TRANSITION_ACTIONS.filter(
  (action) => isClosed(WORK_OBLIGATION_TRANSITIONS[action].to),
).map((action) => WORK_OBLIGATION_TRANSITIONS[action].taskStatus);

const OWNERSHIP_STATES = [
  { acknowledgedAt: null, ownerUserId: null },
  { acknowledgedAt: null, ownerUserId: "user_1" },
  { acknowledgedAt: new Date(), ownerUserId: "user_1" },
];

describe("work obligation transition table", () => {
  test("every action moves work somewhere it can leave again", () => {
    for (const action of WORK_OBLIGATION_TRANSITION_ACTIONS) {
      const { from, to } = WORK_OBLIGATION_TRANSITIONS[action];

      expect(from.length).toBeGreaterThan(0);
      expect(from).not.toContain(to);
      expect(
        WORK_OBLIGATION_TRANSITION_ACTIONS.some((other) =>
          WORK_OBLIGATION_TRANSITIONS[other].from.some(
            (status) => status === to,
          ),
        ),
      ).toBe(true);
    }
  });

  test("no status is a dead end", () => {
    for (const status of WORK_OBLIGATION_STATUSES) {
      expect(
        WORK_OBLIGATION_TRANSITION_ACTIONS.some((action) =>
          WORK_OBLIGATION_TRANSITIONS[action].from.some(
            (from) => from === status,
          ),
        ),
      ).toBe(true);
    }
  });

  test("the mirrored legacy statuses are real task statuses", () => {
    for (const action of WORK_OBLIGATION_TRANSITION_ACTIONS) {
      expect(TASK_STATUSES).toContain(
        WORK_OBLIGATION_TRANSITIONS[action].taskStatus,
      );
    }
  });
});

describe("resolveWorkObligationTransition", () => {
  test("admits exactly the source statuses the table lists", () => {
    for (const action of WORK_OBLIGATION_TRANSITION_ACTIONS) {
      const { from } = WORK_OBLIGATION_TRANSITIONS[action];
      for (const status of WORK_OBLIGATION_STATUSES) {
        const resolution = resolveWorkObligationTransition(action, {
          acknowledgedAt: null,
          ownerUserId: null,
          status,
        });

        expect(resolution.type).toBe(
          from.some((allowed) => allowed === status)
            ? "allowed"
            : "invalid_status",
        );
      }
    }
  });

  test("carries the table's target, event and legacy status", () => {
    const resolution = resolveWorkObligationTransition(
      WORK_OBLIGATION_TRANSITION_ACTION.COMPLETE,
      {
        acknowledgedAt: new Date(),
        ownerUserId: "user_1",
        status: WORK_OBLIGATION_STATUS.ACTIVE,
      },
    );

    expect(resolution).toEqual({
      type: "allowed",
      eventType: WORK_OBLIGATION_TRANSITIONS.complete.eventType,
      from: WORK_OBLIGATION_TRANSITIONS.complete.from,
      nextStatus: WORK_OBLIGATION_TRANSITIONS.complete.to,
      taskStatus: WORK_OBLIGATION_TRANSITIONS.complete.taskStatus,
    });
  });

  test("reopening follows ownership instead of the table's target", () => {
    for (const ownership of OWNERSHIP_STATES) {
      for (const status of CLOSED_STATUSES) {
        const resolution = resolveWorkObligationTransition(
          WORK_OBLIGATION_TRANSITION_ACTION.REOPEN,
          { ...ownership, status },
        );

        expect(resolution).toEqual({
          type: "allowed",
          eventType: WORK_OBLIGATION_TRANSITIONS.reopen.eventType,
          from: WORK_OBLIGATION_TRANSITIONS.reopen.from,
          nextStatus: reopenedWorkObligationStatus(ownership),
          taskStatus: WORK_OBLIGATION_TRANSITIONS.reopen.taskStatus,
        });
      }
    }
  });

  test("reopened work always leaves the closed set", () => {
    for (const ownership of OWNERSHIP_STATES) {
      expect(isClosed(reopenedWorkObligationStatus(ownership))).toBe(false);
    }
  });

  test("only reopening depends on ownership", () => {
    for (const action of WORK_OBLIGATION_TRANSITION_ACTIONS) {
      const statuses = OWNERSHIP_STATES.map((ownership) =>
        nextWorkObligationStatus(action, ownership),
      );
      const fixed = statuses.every(
        (status) => status === WORK_OBLIGATION_TRANSITIONS[action].to,
      );

      expect(fixed).toBe(action !== WORK_OBLIGATION_TRANSITION_ACTION.REOPEN);
    }
  });
});

describe("workObligationIntentForTaskStatus", () => {
  test("round-trips every action through its own legacy status", () => {
    for (const action of WORK_OBLIGATION_TRANSITION_ACTIONS) {
      const { from, taskStatus } = WORK_OBLIGATION_TRANSITIONS[action];
      for (const currentStatus of from) {
        expect(
          workObligationIntentForTaskStatus({
            currentStatus,
            requestedTaskStatus: taskStatus,
          }),
        ).toEqual({ type: "transition", action });
      }
    }
  });

  test("writing the status the work already carries changes nothing", () => {
    for (const action of WORK_OBLIGATION_TRANSITION_ACTIONS) {
      const { taskStatus, to } = WORK_OBLIGATION_TRANSITIONS[action];
      if (!isClosed(to)) {
        continue;
      }

      expect(
        workObligationIntentForTaskStatus({
          currentStatus: to,
          requestedTaskStatus: taskStatus,
        }),
      ).toEqual({ type: "none" });
    }
  });

  test("an open status only means something to closed work", () => {
    const openTaskStatuses = TASK_STATUSES.filter(
      (taskStatus) => !closingTaskStatuses.some((it) => it === taskStatus),
    );

    for (const requestedTaskStatus of openTaskStatuses) {
      for (const currentStatus of WORK_OBLIGATION_STATUSES) {
        expect(
          workObligationIntentForTaskStatus({
            currentStatus,
            requestedTaskStatus,
          }),
        ).toEqual(
          isClosed(currentStatus)
            ? {
                type: "transition",
                action: WORK_OBLIGATION_TRANSITION_ACTION.REOPEN,
              }
            : { type: "none" },
        );
      }
    }
  });

  test("an untouched task status implies nothing", () => {
    for (const currentStatus of WORK_OBLIGATION_STATUSES) {
      expect(
        workObligationIntentForTaskStatus({
          currentStatus,
          requestedTaskStatus: undefined,
        }),
      ).toEqual({ type: "none" });
    }
  });
});
