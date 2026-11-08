import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  pauseRemovalCheckpoint,
  type RemovalCheckpoint,
  removalCheckpointSchema,
} from "./removal-reconciliation-state";

const RESUME_AT = "2026-10-31T16:00:00.000Z";
const LATER = "2026-10-31T17:00:00.000Z";
const running: RemovalCheckpoint = {
  status: "running",
  cursor: "0190f2c4-5b1e-7a4c-9d2e-3f4a5b6c7d8e",
  ceiling: "0190f2c4-5b1e-7a4c-9d2e-3f4a5b6c7d8f",
};
const waiting: RemovalCheckpoint = {
  status: "waiting",
  nextCycleAt: RESUME_AT,
};

describe("pauseRemovalCheckpoint", () => {
  test.each([
    ["no walk", null],
    ["a running walk", running],
    ["a waiting walk", waiting],
  ] as const)("pausing %s resumes it unchanged", (_, current) => {
    const paused = pauseRemovalCheckpoint(current, RESUME_AT);
    expect(paused).toEqual({
      status: "paused",
      resume: current,
      resumeAt: RESUME_AT,
    });
    expect(v.is(removalCheckpointSchema, paused)).toBe(true);
  });

  test("pausing a paused source keeps the walk it was paused from", () => {
    const first = pauseRemovalCheckpoint(running, RESUME_AT);
    const second = pauseRemovalCheckpoint(first, LATER);
    expect(second).toEqual({
      status: "paused",
      resume: running,
      resumeAt: LATER,
    });
    expect(v.is(removalCheckpointSchema, second)).toBe(true);
  });

  test("the schema refuses a pause nested inside a pause", () => {
    const nested = {
      status: "paused",
      resume: { status: "paused", resume: running, resumeAt: RESUME_AT },
      resumeAt: LATER,
    };
    expect(v.is(removalCheckpointSchema, nested)).toBe(false);
  });
});
