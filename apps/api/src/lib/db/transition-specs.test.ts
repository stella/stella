import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { WORK_OBLIGATION_STATUSES } from "@/api/db/schema";
import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import { permitsTransition } from "@/api/lib/db/transitions";
import {
  WORK_OBLIGATION_TRANSITIONS,
  WORK_OBLIGATION_SOURCE_SETTLEMENT,
  reopenedWorkObligationStatus,
} from "@/api/lib/work-obligations/transitions";

test("obligation membership and lifecycle transitions share the declared graph", () => {
  for (const from of ["active", "awaiting_acknowledgement"] as const) {
    expect(
      permitsTransition(TRANSITIONS.workObligations, from, "unassigned"),
    ).toBe(true);
    expect(
      permitsTransition(
        TRANSITIONS.workObligations,
        from,
        "awaiting_acknowledgement",
      ),
    ).toBe(true);
  }
  for (const { from, to } of Object.values(WORK_OBLIGATION_TRANSITIONS)) {
    for (const source of from) {
      expect(permitsTransition(TRANSITIONS.workObligations, source, to)).toBe(
        true,
      );
    }
  }
  for (const { from, nextStatus } of Object.values(
    WORK_OBLIGATION_SOURCE_SETTLEMENT,
  )) {
    for (const source of from) {
      expect(
        permitsTransition(TRANSITIONS.workObligations, source, nextStatus),
      ).toBe(true);
    }
  }
  for (const ownerUserId of [null, "member"]) {
    for (const acknowledgedAt of [null, new Date(0)]) {
      for (const closed of WORK_OBLIGATION_TRANSITIONS.reopen.from) {
        expect(
          permitsTransition(
            TRANSITIONS.workObligations,
            closed,
            reopenedWorkObligationStatus({ ownerUserId, acknowledgedAt }),
          ),
        ).toBe(true);
      }
    }
  }
});

test("closed exchanges remain closed for every declared target", () => {
  for (const spec of [
    TRANSITIONS.desktopEditSessions,
    TRANSITIONS.pdfSigningSessions,
  ]) {
    for (const terminal of spec.terminal) {
      for (const target of Object.keys(spec.edges)) {
        expect(permitsTransition(spec, terminal, target)).toBe(
          terminal === target,
        );
      }
    }
  }
});

test("obligation graph covers exactly the stored status domain", () => {
  assertProperty(
    "obligation graph covers exactly the stored status domain",
    fc.property(fc.constantFrom(...WORK_OBLIGATION_STATUSES), (status) => {
      expect(
        permitsTransition(TRANSITIONS.workObligations, status, status),
      ).toBe(true);
    }),
  );
  expect(Object.keys(TRANSITIONS.workObligations.edges).toSorted()).toEqual(
    [...WORK_OBLIGATION_STATUSES].toSorted(),
  );
});

test("citation recounts publish exact state without reopening pending state", () => {
  const spec = TRANSITIONS.caseLawDecisionCitationStatsState;
  expect(permitsTransition(spec, "pending", "exact")).toBe(true);
  expect(permitsTransition(spec, "exact", "exact")).toBe(true);
  expect(permitsTransition(spec, "exact", "pending")).toBe(false);
});
