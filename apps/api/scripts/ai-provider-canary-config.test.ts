import { describe, expect, test } from "bun:test";

import {
  BYOK_MODEL_OPTIONS,
  DEFAULT_MODELS,
  isBYOKModelRoleSupported,
  MODEL_ROLES,
} from "@stll/ai-catalog";

import {
  CANARY_PROVIDERS,
  missingCanaryProviders,
  modelRoleMaxOutputTokens,
  WEEKLY_TOOL_SHAPES,
  weeklyCanaryRotation,
} from "./ai-provider-canary-config";

describe("AI provider canary role budgets", () => {
  test("reserves reasoning capacity without inflating other role probes", () => {
    for (const role of MODEL_ROLES) {
      expect(modelRoleMaxOutputTokens(role)).toBe(
        role === "reasoning" ? 25_000 : 512,
      );
    }
  });
});

describe("AI provider canary coverage", () => {
  test("requires every supported provider for an all-provider run", () => {
    const configuredProviders = CANARY_PROVIDERS.filter(
      (provider) => provider !== "bedrock",
    );

    expect(
      missingCanaryProviders({ configuredProviders, selection: "all" }),
    ).toEqual(["bedrock"]);
  });

  test("requires only the selected provider for a focused manual run", () => {
    expect(
      missingCanaryProviders({
        configuredProviders: ["openai"],
        selection: "openai",
      }),
    ).toEqual([]);
    expect(
      missingCanaryProviders({
        configuredProviders: ["openai"],
        selection: "bedrock",
      }),
    ).toEqual(["bedrock"]);
  });
});

describe("AI provider weekly rotation", () => {
  test("cycles through every curated model with non-default supported roles", () => {
    for (const provider of CANARY_PROVIDERS) {
      const models = BYOK_MODEL_OPTIONS[provider];
      const rotations = models.map((_, rotationIndex) =>
        weeklyCanaryRotation({ provider, rotationIndex }),
      );

      expect(rotations.map(({ modelId }) => modelId)).toEqual(models);
      expect(
        weeklyCanaryRotation({
          provider,
          rotationIndex: models.length,
        }).modelId,
      ).toBe(models.at(0));

      for (const { modelId, modelRoles } of rotations) {
        expect(modelRoles.length).toBeGreaterThan(0);
        for (const role of modelRoles) {
          expect(modelId).not.toBe(DEFAULT_MODELS[provider][role]);
          expect(isBYOKModelRoleSupported({ modelId, provider, role })).toBe(
            true,
          );
        }
      }
    }
  });

  test("rotates executable tool shapes independently of model catalog size", () => {
    for (const [rotationIndex, toolShape] of WEEKLY_TOOL_SHAPES.entries()) {
      expect(
        weeklyCanaryRotation({ provider: "openai", rotationIndex }).toolShape,
      ).toBe(toolShape);
    }
    expect(
      weeklyCanaryRotation({
        provider: "openai",
        rotationIndex: WEEKLY_TOOL_SHAPES.length,
      }).toolShape,
    ).toBe(WEEKLY_TOOL_SHAPES.at(0));
  });

  test("rejects invalid rotation indexes", () => {
    expect(() =>
      weeklyCanaryRotation({ provider: "google", rotationIndex: -1 }),
    ).toThrow("Weekly canary rotation index must be non-negative.");
  });
});
