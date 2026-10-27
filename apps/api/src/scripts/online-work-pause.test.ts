import { describe, expect, test } from "bun:test";

import { ONLINE_WORK_NAMES } from "@/api/db/online-migrations";
import { decodeOnlineWorkState } from "@/api/db/online-work-pause";
import { ONLINE_WORK_STATES } from "@/api/db/schema/online-work-state";
import { ONLINE_WORK_STATE_TRANSITIONS } from "@/api/lib/db/transition-specs";

import {
  OnlineWorkPauseError,
  parseOnlineWorkPauseArgs,
} from "./online-work-pause";

const name = ONLINE_WORK_NAMES.at(0);
if (name === undefined) {
  throw new TypeError("Expected a registered online unit");
}
const pause = [
  "pause",
  "--step",
  name,
  "--for",
  "24h",
  "--actor",
  "operator",
  "--reason",
  "Maintenance window",
];

describe("online step operator pauses", () => {
  test("uses the same bounded attributed dry-run and apply surface as scheduler pauses", () => {
    expect(parseOnlineWorkPauseArgs(pause)).toEqual({
      action: "pause",
      name,
      durationMinutes: 1440,
      actor: "operator",
      reason: "Maintenance window",
      apply: false,
    });
    expect(parseOnlineWorkPauseArgs([...pause, "--apply"])).toMatchObject({
      apply: true,
    });
    expect(parseOnlineWorkPauseArgs(["status", "--step", name])).toEqual({
      action: "status",
      name,
    });
    expect(
      parseOnlineWorkPauseArgs([
        "resume",
        "--step",
        name,
        "--actor",
        "operator",
        "--reason",
        "Maintenance complete",
        "--apply",
      ]),
    ).toEqual({
      action: "resume",
      name,
      actor: "operator",
      reason: "Maintenance complete",
      apply: true,
    });
  });

  test("rejects unknown units, unbounded pauses, missing attribution and ambiguous flags", () => {
    const cases = [
      [
        "pause",
        "--step",
        "unknown",
        "--for",
        "1h",
        "--actor",
        "operator",
        "--reason",
        "Maintenance window",
      ],
      pause.map((value) => (value === "24h" ? "73h" : value)),
      pause.map((value) => (value === "24h" ? "0h" : value)),
      pause.map((value) => (value === "operator" ? " " : value)),
      pause.map((value) => (value === "Maintenance window" ? "short" : value)),
      [...pause, "--apply", "--apply"],
      ["status", "--apply"],
    ];
    for (const args of cases) {
      expect(() => parseOnlineWorkPauseArgs(args)).toThrow(
        OnlineWorkPauseError,
      );
    }
  });

  test("the transition owner is total over the persisted domain and done cannot reopen", () => {
    expect(Object.keys(ONLINE_WORK_STATE_TRANSITIONS.edges).toSorted()).toEqual(
      [...ONLINE_WORK_STATES].toSorted(),
    );
    expect(ONLINE_WORK_STATE_TRANSITIONS.edges.done).toEqual([]);
    for (const targets of Object.values(ONLINE_WORK_STATE_TRANSITIONS.edges)) {
      for (const target of targets) {
        expect(ONLINE_WORK_STATES).toContain(target);
      }
    }
  });

  test("foundation spellings normalize to the five-state read contract", () => {
    expect(decodeOnlineWorkState("building")).toBe("running");
    expect(decodeOnlineWorkState("finalized")).toBe("done");
    for (const state of ONLINE_WORK_STATES) {
      expect(decodeOnlineWorkState(state)).toBe(state);
    }
    expect(() => decodeOnlineWorkState("unknown")).toThrow(
      "Unknown online work state",
    );
  });
});
