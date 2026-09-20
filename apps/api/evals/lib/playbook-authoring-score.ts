/**
 * Pure scoring for the playbook-authoring eval: what a run's `save_playbook`
 * calls and the playbook they left behind say about the tool contract. No
 * model, no store; the eval script gathers the evidence and this judges it.
 */

import type { Position } from "@/api/lib/workflow/playbook-positions";

export type SaveCallRecord = {
  /** The raw input, before any parse: a refused call is kept whole. */
  input: unknown;
  /** The envelope code of a refused call; `null` when the call saved. */
  refusal: string | null;
};

export type PlaybookExpectation = {
  /** Issues the final playbook must hold, compared without case. */
  presentIssues: readonly string[];
  /** Issues it must not hold. */
  absentIssues: readonly string[];
  /** Seeded positions no call should have altered, by `sourceId`. */
  untouchedSourceIds: readonly string[];
  /**
   * Refusals the task plants on purpose (a stale token, a duplicate issue), by
   * envelope code. Meeting one is the scenario, not a contract failure.
   */
  plantedRefusals: readonly string[];
  /** Positions one call may carry: the ones the brief asked to add or change. */
  maxPositionsPerCall: number;
  /** Scenario-specific defects in the final positions; empty when clean. */
  check: (positions: readonly Position[]) => string[];
};

export const PLAYBOOK_STEP_NAMES = [
  "accepted",
  "saved",
  "minimal",
  "untouched",
] as const;

export type PlaybookSteps = Record<
  (typeof PLAYBOOK_STEP_NAMES)[number],
  boolean
>;

export type PlaybookRunScore = {
  outcome: "pass" | "partial" | "no-call" | "error";
  steps: PlaybookSteps;
  /** Save calls the tool refused, in order, by envelope code. */
  refusals: string[];
  defects: string[];
};

const issueKey = (issue: string): string => issue.trim().toLowerCase();

const positionsCarried = (input: unknown): number => {
  if (typeof input !== "object" || input === null || !("positions" in input)) {
    return 0;
  }
  return Array.isArray(input.positions) ? input.positions.length : 0;
};

export const scorePlaybookRun = ({
  calls,
  expectation,
  finalPositions,
  seededPositions,
  turnError,
}: {
  calls: readonly SaveCallRecord[];
  expectation: PlaybookExpectation;
  /** `null` when the run left no playbook to judge. */
  finalPositions: readonly Position[] | null;
  seededPositions: readonly Position[];
  turnError: string | null;
}): PlaybookRunScore => {
  const refusals = calls.flatMap(({ refusal }) =>
    refusal === null ? [] : [refusal],
  );
  // Each planted refusal excuses one refusal of its code; the rest are the
  // contract (or the model) failing, and are what `accepted` reports.
  const excusable = [...expectation.plantedRefusals];
  const unplanted = refusals.filter((code) => {
    const index = excusable.indexOf(code);
    if (index === -1) {
      return true;
    }
    excusable.splice(index, 1);
    return false;
  });
  const defects: string[] = [];
  const held = new Set(
    (finalPositions ?? []).map(({ issue }) => issueKey(issue)),
  );
  for (const issue of expectation.presentIssues) {
    if (!held.has(issueKey(issue))) {
      defects.push(`missing position: ${issue}`);
    }
  }
  for (const issue of expectation.absentIssues) {
    if (held.has(issueKey(issue))) {
      defects.push(`position should be gone: ${issue}`);
    }
  }
  if (held.size !== (finalPositions ?? []).length) {
    defects.push("two positions share an issue");
  }
  if (finalPositions !== null) {
    defects.push(...expectation.check(finalPositions));
  }

  const altered = expectation.untouchedSourceIds.filter((sourceId) => {
    const before = seededPositions.find((seed) => seed.sourceId === sourceId);
    const after = finalPositions?.find((final) => final.sourceId === sourceId);
    return JSON.stringify(before) !== JSON.stringify(after);
  });
  const oversized = calls.filter(
    ({ input }) => positionsCarried(input) > expectation.maxPositionsPerCall,
  );

  const steps: PlaybookSteps = {
    accepted: calls.length > 0 && unplanted.length === 0,
    saved: finalPositions !== null && defects.length === 0,
    minimal: calls.length > 0 && oversized.length === 0,
    untouched: finalPositions !== null && altered.length === 0,
  };
  if (altered.length > 0) {
    defects.push(
      `altered positions it was not asked to: ${altered.join(", ")}`,
    );
  }
  if (oversized.length > 0) {
    defects.push(
      `${String(oversized.length)} call(s) resent positions that did not change`,
    );
  }

  if (turnError !== null) {
    return { outcome: "error", steps, refusals, defects: [turnError] };
  }
  if (calls.length === 0) {
    return { outcome: "no-call", steps, refusals, defects };
  }
  return {
    outcome: Object.values(steps).every(Boolean) ? "pass" : "partial",
    steps,
    refusals,
    defects,
  };
};
