import { describe, expect, test } from "bun:test";

import { canApplyRecorderAction } from "./recorder-state";

type Action = Parameters<typeof canApplyRecorderAction>[1];
type Status = Parameters<typeof canApplyRecorderAction>[0];

const actionCases = {
  record: { action: "record", accepted: ["idle"] },
  pause: { action: "pause", accepted: ["recording"] },
  resume: { action: "resume", accepted: ["paused"] },
  finish: { action: "finish", accepted: ["recording", "paused"] },
  marker: { action: "marker", accepted: ["recording"] },
  delete: { action: "delete", accepted: ["paused", "finished"] },
} as const satisfies {
  [Operation in Action]: { action: Operation; accepted: readonly Status[] };
};

const statusCases = {
  idle: "idle",
  recording: "recording",
  paused: "paused",
  finished: "finished",
} as const satisfies { [State in Status]: State };

describe("dictation recorder controls", () => {
  test("each operation is available only in its accepted lifecycle states", () => {
    for (const { action, accepted } of Object.values(actionCases)) {
      for (const status of Object.values(statusCases)) {
        expect(canApplyRecorderAction(status, action)).toBe(
          accepted.some((allowed) => allowed === status),
        );
      }
    }
  });

  test("an interrupted recording can resume without enabling another recording", () => {
    expect(canApplyRecorderAction("recording", "pause")).toBe(true);
    expect(canApplyRecorderAction("paused", "resume")).toBe(true);
    expect(canApplyRecorderAction("paused", "record")).toBe(false);
    expect(canApplyRecorderAction("recording", "resume")).toBe(false);
  });

  test("a stopped recording cannot receive new samples or markers", () => {
    expect(canApplyRecorderAction("finished", "resume")).toBe(false);
    expect(canApplyRecorderAction("finished", "marker")).toBe(false);
    expect(canApplyRecorderAction("finished", "delete")).toBe(true);
  });
});
