import { expect, test } from "bun:test";

import {
  BYOK_MODEL_OPTIONS,
  getModelReasoningCapabilities,
  MODEL_REASONING_CAPABILITIES,
  REASONING_REPLAY_FORMATS,
  RETAINED_MODELS_DEV_RATE_ENTRIES,
} from "./index";

test("every offered model declares reasoning support and replay requirements", () => {
  const offered = Object.values(BYOK_MODEL_OPTIONS).flat();
  expect(Object.keys(MODEL_REASONING_CAPABILITIES).toSorted()).toEqual(
    [...offered, ...Object.keys(RETAINED_MODELS_DEV_RATE_ENTRIES)].toSorted(),
  );
  for (const [provider, models] of Object.entries(BYOK_MODEL_OPTIONS)) {
    for (const model of models) {
      const capability = getModelReasoningCapabilities(model);
      expect(capability).not.toBeNull();
      if (capability === null) {
        continue;
      }
      expect(["supported", "unsupported"]).toContain(capability.support);
      expect(capability.emittedFormats.length).toBeGreaterThan(0);
      for (const format of capability.emittedFormats) {
        expect(REASONING_REPLAY_FORMATS).toContain(format);
      }
      if (provider === "openai" && capability.support === "supported") {
        expect(capability.openAIIncludeEncryptedContent).toBe(true);
        expect(capability.openAIStore).toBe(false);
        expect(capability.emittedFormats).toEqual(["openai-encrypted-content"]);
      }
      for (const provenance of capability.replayCompatibility) {
        expect<string>(provenance.provider).toBe(provider);
        expect(provenance.model).toBe(model);
        expect(provenance.format).not.toBe("none");
        expect(capability.emittedFormats).toContain(provenance.format);
      }
      if (capability.support === "unsupported") {
        expect(capability.replayCompatibility).toEqual([]);
      }
    }
  }
});

test("unknown model identities cannot inherit reasoning replay capabilities", () => {
  expect(getModelReasoningCapabilities("claude-sonnet-5-unknown")).toBeNull();
  expect(getModelReasoningCapabilities("gpt-unknown")).toBeNull();
  expect(getModelReasoningCapabilities("gemini-unknown")).toBeNull();
  for (const inherited of ["constructor", "toString", "__proto__"]) {
    expect(getModelReasoningCapabilities(inherited)).toBeNull();
  }
});
