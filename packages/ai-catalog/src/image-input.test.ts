import { expect, test } from "bun:test";

import {
  BYOK_MODEL_OPTIONS,
  IMAGE_INPUT_CAPABILITIES,
  MODEL_IMAGE_INPUT_CAPABILITIES,
  TANSTACK_AI_PROVIDERS,
  getModelImageInputCapability,
} from "./index";

test("every offered provider model has explicit image-input evidence", () => {
  for (const provider of TANSTACK_AI_PROVIDERS) {
    expect(
      Object.keys(MODEL_IMAGE_INPUT_CAPABILITIES[provider]).toSorted(),
    ).toEqual([...BYOK_MODEL_OPTIONS[provider]].toSorted());
    for (const modelId of BYOK_MODEL_OPTIONS[provider]) {
      const capability = getModelImageInputCapability({ provider, modelId });
      expect(IMAGE_INPUT_CAPABILITIES).toContain(capability);
    }
  }
});

test("unoffered models have no catalog evidence", () => {
  for (const provider of TANSTACK_AI_PROVIDERS) {
    for (const modelId of [
      "unlisted-model",
      "constructor",
      "toString",
      "__proto__",
    ]) {
      expect(
        getModelImageInputCapability({ provider, modelId }),
      ).toBeUndefined();
    }
  }
});
