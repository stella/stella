import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";

import {
  parseSchedulerJobPauseArgs,
  runSchedulerJobPause,
  SchedulerJobPauseError,
} from "./scheduler-job-pause";

const jobId = DECLARED_SCHEDULER_JOBS.at(0)?.id ?? "missing-declaration";

describe("scheduler job pause arguments", () => {
  test("parses bounded minute and hour pauses", () => {
    expect(
      parseSchedulerJobPauseArgs([
        "pause",
        "--job",
        jobId,
        "--for",
        "30m",
        "--reason",
        "Runaway queue growth",
        "--actor",
        " operator ",
      ]),
    ).toEqual({
      action: "pause",
      actor: "operator",
      apply: false,
      durationMinutes: 30,
      jobId,
      reason: "Runaway queue growth",
    });
    expect(
      parseSchedulerJobPauseArgs([
        "pause",
        "--job",
        jobId,
        "--for",
        "72h",
        "--reason",
        "Runaway queue growth",
        "--actor",
        "operator",
        "--apply",
      ]),
    ).toMatchObject({ apply: true, durationMinutes: 4320 });
  });

  test("parses resume and status commands", () => {
    expect(
      parseSchedulerJobPauseArgs([
        "resume",
        "--job",
        jobId,
        "--reason",
        "Queue recovered",
        "--actor",
        "operator",
      ]),
    ).toEqual({
      action: "resume",
      actor: "operator",
      apply: false,
      jobId,
      reason: "Queue recovered",
    });
    expect(parseSchedulerJobPauseArgs(["status"])).toEqual({
      action: "status",
    });
    expect(parseSchedulerJobPauseArgs(["status", "--job", jobId])).toEqual({
      action: "status",
      jobId,
    });
  });

  test.each([
    [
      [
        "pause",
        "--job",
        jobId,
        "--for",
        "73h",
        "--reason",
        "Long enough",
        "--actor",
        "operator",
      ],
      "must not exceed 72 hours",
    ],
    [
      [
        "pause",
        "--job",
        jobId,
        "--for",
        "0m",
        "--reason",
        "Long enough",
        "--actor",
        "operator",
      ],
      "greater than zero",
    ],
    [
      [
        "pause",
        "--job",
        jobId,
        "--for",
        "1h",
        "--reason",
        "1234567",
        "--actor",
        "operator",
      ],
      "at least eight characters",
    ],
    [
      [
        "pause",
        "--job",
        jobId,
        "--for",
        "1h",
        "--reason",
        "Long enough",
        "--actor",
        "   ",
      ],
      "must not be blank",
    ],
    [
      [
        "pause",
        "--job",
        "not.a.job",
        "--for",
        "1h",
        "--reason",
        "Long enough",
        "--actor",
        "operator",
      ],
      "Valid ids:",
    ],
  ] as const)("refuses invalid input before execution", (args, message) => {
    expect(() => parseSchedulerJobPauseArgs(args)).toThrow(
      new RegExp(message, "u"),
    );
    expect(() => parseSchedulerJobPauseArgs(args)).toThrow(
      SchedulerJobPauseError,
    );
  });

  test("an applied command fails when its single update returns no row", async () => {
    const command = parseSchedulerJobPauseArgs([
      "resume",
      "--job",
      jobId,
      "--reason",
      "Queue recovered",
      "--actor",
      "operator",
      "--apply",
    ]);
    const execution = runSchedulerJobPause(command, {
      db: { execute: async () => [] },
      write: () => undefined,
    });
    const rejection = await rejectionOf(execution);
    expect(rejection).toBeInstanceOf(SchedulerJobPauseError);
    expect(rejection).toHaveProperty(
      "message",
      expect.stringContaining("no update was applied"),
    );
  });
});
