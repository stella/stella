import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { reportCaseLawIncompleteAnswer } from "@/api/lib/case-law/incomplete-answer-telemetry";
import type { RecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";

describe("case-law incomplete-answer telemetry", () => {
  let recording: RecordingLogger;

  beforeEach(() => {
    recording = installRecordingLogger();
  });

  afterEach(() => {
    recording.restore();
  });

  test("emits the typed surface, reason and count", () => {
    reportCaseLawIncompleteAnswer({
      surface: "search",
      reason: "pagination_truncated",
      count: 2,
    });

    expect(recording.records).toEqual([
      {
        severityText: "INFO",
        message: "case_law.answer.incomplete",
        attributes: {
          surface: "search",
          reason: "pagination_truncated",
          count: 2,
        },
      },
    ]);
  });

  test("does not emit an empty count", () => {
    reportCaseLawIncompleteAnswer({
      surface: "research",
      reason: "passage_budget",
      count: 0,
    });
    expect(recording.records).toEqual([]);
  });
});
