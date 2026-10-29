import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  getTranscriptionModel,
  isTranscriptionModelId,
  TRANSCRIPTION_MODELS,
} from "./transcription";

test("transcription lookup accepts exactly the catalog model identifiers", () => {
  assertProperty(
    "transcription lookup accepts exactly the catalog model identifiers",
    fc.property(
      fc.oneof(
        fc.string(),
        fc.constantFrom(...Object.keys(TRANSCRIPTION_MODELS)),
        fc.constantFrom("constructor", "__proto__", "toString", "valueOf"),
      ),
      (modelId) => {
        expect(isTranscriptionModelId(modelId)).toBe(
          Object.hasOwn(TRANSCRIPTION_MODELS, modelId),
        );
        expect(getTranscriptionModel(modelId) !== undefined).toBe(
          Object.hasOwn(TRANSCRIPTION_MODELS, modelId),
        );
      },
    ),
  );
});

test("transcription lookup preserves the evidence for every catalog model", () => {
  for (const [modelId, metadata] of Object.entries(TRANSCRIPTION_MODELS)) {
    if (!isTranscriptionModelId(modelId)) {
      throw new TypeError(
        "Catalog entries require a transcription model identifier",
      );
    }
    expect(getTranscriptionModel(modelId)).toBe(metadata);
    expect(metadata.source.url).toBe(`https://openrouter.ai/${modelId}`);
    expect(metadata.source.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(Number.isSafeInteger(metadata.price.usdNumerator)).toBe(true);
    expect(Number.isSafeInteger(metadata.price.secondsDenominator)).toBe(true);
    expect(metadata.price.usdNumerator).toBeGreaterThan(0);
    expect(metadata.price.secondsDenominator).toBeGreaterThan(0);
    for (const availability of Object.values(metadata.residency)) {
      if (availability.status !== "available") {
        continue;
      }
      expect(Number.isSafeInteger(availability.price.usdNumerator)).toBe(true);
      expect(Number.isSafeInteger(availability.price.secondsDenominator)).toBe(
        true,
      );
      expect(availability.price.usdNumerator).toBeGreaterThan(0);
      expect(availability.price.secondsDenominator).toBeGreaterThan(0);
    }
  }
});
