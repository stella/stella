import { afterEach, describe, expect, test } from "bun:test";

import { readGeneratedCursorValues } from "@/api/lib/entities/window-cursor";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

describe("readGeneratedCursorValues", () => {
  let analytics: RecordingAnalytics | null = null;
  let logs: RecordingLogger | null = null;

  afterEach(() => {
    analytics?.restore();
    logs?.restore();
    analytics = null;
    logs = null;
  });

  test("reads the values whether the driver returns them parsed or as JSON text", () => {
    logs = installRecordingLogger();

    expect(readGeneratedCursorValues(["b", 2, null])).toEqual(["b", 2, null]);
    expect(readGeneratedCursorValues('["b", 2, null]')).toEqual(["b", 2, null]);
    expect(logs.records).toEqual([]);
  });

  test("reports cursor values that are not readable JSON", () => {
    analytics = installRecordingAnalytics();
    logs = installRecordingLogger();

    expect(readGeneratedCursorValues('["b", 2')).toEqual([]);

    expect(logs.at("ERROR").map(({ message }) => message)).toEqual([
      "entities.window_cursor_values_unreadable",
    ]);
    expect(analytics.exceptions()).toHaveLength(1);
  });

  test("reports cursor values of a shape the query never generates", () => {
    logs = installRecordingLogger();

    expect(readGeneratedCursorValues({ values: ["b"] })).toEqual([]);

    expect(logs.at("ERROR").map(({ message }) => message)).toEqual([
      "entities.window_cursor_values_unreadable",
    ]);
  });
});
