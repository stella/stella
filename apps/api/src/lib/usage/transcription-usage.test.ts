import { expect, test } from "bun:test";
import * as fc from "fast-check";

import {
  isTranscriptionModelId,
  TRANSCRIPTION_MODELS,
} from "@stll/ai-catalog/transcription";
import { assertProperty } from "@stll/property-testing";

import { USAGE_ACTION_TYPES, USAGE_SERVICE_TIERS } from "@/api/db/schema";
import { computeUsageUnitCost } from "@/api/lib/usage/action-weights";
import { transcriptionUsageUnits } from "@/api/lib/usage/unit-model";

const MODEL_ID = "mistralai/voxtral-mini-transcribe";

test("every action and tier attributes organization-key work without consumption", () => {
  for (const actionType of USAGE_ACTION_TYPES) {
    for (const serviceTier of USAGE_SERVICE_TIERS) {
      expect(
        computeUsageUnitCost({ actionType, serviceTier, isByok: true }),
      ).toBe(0);
      expect(
        computeUsageUnitCost({ actionType, serviceTier, isByok: false }),
      ).toBeGreaterThan(0);
    }
  }
});

test("transcription duration settles the regional rate and partial seconds", () => {
  expect(
    transcriptionUsageUnits({
      modelId: MODEL_ID,
      residency: "eu",
      durationMs: 1000,
      isByok: false,
    }),
  ).toEqual({ rawUsageMicroUnits: 6, unitsConsumed: 2 });
  expect(
    transcriptionUsageUnits({
      modelId: MODEL_ID,
      residency: "eu",
      durationMs: 1_000_000,
      isByok: false,
    }),
  ).toEqual({ rawUsageMicroUnits: 5500, unitsConsumed: 83 });
  expect(
    transcriptionUsageUnits({
      modelId: MODEL_ID,
      residency: "eu",
      durationMs: 20_000,
      isByok: true,
    }),
  ).toEqual({ rawUsageMicroUnits: 110, unitsConsumed: 0 });
  expect(
    transcriptionUsageUnits({
      modelId: MODEL_ID,
      residency: "eu",
      durationMs: 1,
      isByok: true,
    }),
  ).toEqual({ rawUsageMicroUnits: 1, unitsConsumed: 0 });
});

test("transcription rejects invalid duration before accounting", () => {
  for (const durationMs of [
    -1,
    0.5,
    Number.NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expect(() =>
      transcriptionUsageUnits({
        modelId: MODEL_ID,
        residency: "eu",
        durationMs,
        isByok: false,
      }),
    ).toThrow("Transcription duration must be a non-negative safe integer");
  }
});

test("transcription refuses every region without a confirmed rate", () => {
  for (const modelId of Object.keys(TRANSCRIPTION_MODELS).filter(
    isTranscriptionModelId,
  )) {
    for (const residency of ["eu", "us"] as const) {
      if (
        TRANSCRIPTION_MODELS[modelId].residency[residency].status ===
        "available"
      ) {
        continue;
      }
      expect(() =>
        transcriptionUsageUnits({
          modelId,
          residency,
          durationMs: 1000,
          isByok: false,
        }),
      ).toThrow("Transcription model must have a confirmed regional rate");
    }
  }
});

test("transcription usage remains monotone and organization keys preserve attribution", () => {
  assertProperty(
    "transcription usage remains monotone and organization keys preserve attribution",
    fc.property(
      fc.integer({ min: 0, max: 86_400_000 }),
      fc.integer({ min: 0, max: 86_400_000 }),
      (first, second) => {
        const low = Math.min(first, second);
        const high = Math.max(first, second);
        for (const modelId of Object.keys(TRANSCRIPTION_MODELS).filter(
          isTranscriptionModelId,
        )) {
          for (const residency of ["eu", "us"] as const) {
            if (
              TRANSCRIPTION_MODELS[modelId].residency[residency].status !==
              "available"
            ) {
              continue;
            }
            const smaller = transcriptionUsageUnits({
              modelId,
              residency,
              durationMs: low,
              isByok: false,
            });
            const larger = transcriptionUsageUnits({
              modelId,
              residency,
              durationMs: high,
              isByok: false,
            });
            const ownKey = transcriptionUsageUnits({
              modelId,
              residency,
              durationMs: high,
              isByok: true,
            });
            expect(larger.rawUsageMicroUnits).toBeGreaterThanOrEqual(
              smaller.rawUsageMicroUnits,
            );
            expect(larger.unitsConsumed).toBeGreaterThanOrEqual(
              smaller.unitsConsumed,
            );
            expect(Number.isSafeInteger(larger.rawUsageMicroUnits)).toBe(true);
            expect(Number.isSafeInteger(larger.unitsConsumed)).toBe(true);
            expect(ownKey).toEqual({
              rawUsageMicroUnits: larger.rawUsageMicroUnits,
              unitsConsumed: 0,
            });
          }
        }
      },
    ),
  );
});
