import { describe, expect, test } from "bun:test";

import type { DecisionAnalysis } from "@stll/legal-ast/analysis";

import { toSafeId } from "@/api/lib/branded-types";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";

import { persistGeneratedAnalysis } from "./generate";

describe("persisting a generated case-law analysis", () => {
  test("does not report a valid generated output as incomplete when saving fails", async () => {
    const recording = installRecordingLogger();
    const analysis = {
      version: 2,
      generatedAt: "2026-10-09T00:00:00.000Z",
      model: "test-model",
      inputFingerprint: "input-fingerprint",
      tree: [],
    } satisfies DecisionAnalysis;
    const persistenceError = new Error("persistence unavailable");
    const failures: unknown[] = [];

    try {
      await persistGeneratedAnalysis({
        analysis,
        contentHash: "content-hash",
        decisionId: toSafeId<"caseLawDecision">(
          "0199c95c-2e80-7000-8000-000000000001",
        ),
        onFailure: async (error) => {
          failures.push(error);
        },
        persistence: {
          save: async () => {
            throw persistenceError;
          },
        },
      });
      expect(failures).toEqual([persistenceError]);
      expect(recording.records).toEqual([]);
    } finally {
      recording.restore();
    }
  });
});
