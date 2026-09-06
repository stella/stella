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
  structuredOutputBudgetEdgeMaxOutputTokens,
  structuredOutputModelRoleMaxOutputTokens,
  TOOL_CALL_PROBE_MAX_OUTPUT_TOKENS,
  WEEKLY_TOOL_SHAPES,
  weeklyCanaryRotation,
} from "./ai-provider-canary-config";

describe("AI provider canary role budgets", () => {
  const model = "model";

  test("keeps structured probes within the provider timeout envelope", () => {
    for (const role of MODEL_ROLES) {
      expect(
        structuredOutputModelRoleMaxOutputTokens({ modelId: model, role }),
      ).toBeLessThanOrEqual(modelRoleMaxOutputTokens({ modelId: model, role }));
    }

    expect(
      structuredOutputModelRoleMaxOutputTokens({
        modelId: model,
        role: "reasoning",
      }),
    ).toBeLessThan(21_000);
    expect(
      modelRoleMaxOutputTokens({ modelId: model, role: "reasoning" }),
    ).toBeGreaterThan(
      structuredOutputModelRoleMaxOutputTokens({
        modelId: model,
        role: "reasoning",
      }),
    );
  });

  test("budgets tool-execution probes above every short-reply role", () => {
    for (const role of MODEL_ROLES) {
      if (role === "reasoning") {
        continue;
      }
      expect(TOOL_CALL_PROBE_MAX_OUTPUT_TOKENS).toBeGreaterThan(
        modelRoleMaxOutputTokens({ modelId: model, role }),
      );
    }
    // Amazon Nova v1 accepts at most 10,000 output tokens and takes part in
    // the weekly rotation; a larger ceiling is rejected before the tool call.
    expect(TOOL_CALL_PROBE_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(10_000);
  });

  test("budgets the budget-edge probe above a truncating ceiling", () => {
    // A one-property schema still gets the tool-execution headroom: the
    // "fast"-role default is a provider's smallest model, and a structured
    // object cut off mid-tool-use is rejected, not shortened.
    expect(
      structuredOutputBudgetEdgeMaxOutputTokens({
        modelId: model,
        propertyCount: 1,
      }),
    ).toBe(TOOL_CALL_PROBE_MAX_OUTPUT_TOKENS);
    // Past that floor the ceiling still grows with the schema actually sent.
    expect(
      structuredOutputBudgetEdgeMaxOutputTokens({
        modelId: model,
        propertyCount: 200,
      }),
    ).toBeGreaterThan(TOOL_CALL_PROBE_MAX_OUTPUT_TOKENS);
  });

  test("clamps role budgets to a model's output limit", () => {
    const nova = "us.amazon.nova-lite-v1:0";
    for (const role of MODEL_ROLES) {
      expect(
        modelRoleMaxOutputTokens({ modelId: nova, role }),
      ).toBeLessThanOrEqual(10_000);
      expect(
        structuredOutputModelRoleMaxOutputTokens({ modelId: nova, role }),
      ).toBeLessThanOrEqual(10_000);
    }
    expect(
      modelRoleMaxOutputTokens({ modelId: model, role: "reasoning" }),
    ).toBeGreaterThan(10_000);
  });
});

describe("AI provider canary coverage", () => {
  test("keeps the scheduled workflow matrix aligned with the provider catalog", async () => {
    const workflow = await Bun.file(
      new URL(
        "../../../.github/workflows/ai-provider-canary.yml",
        import.meta.url,
      ),
    ).text();
    const scheduledMatrix = JSON.stringify(CANARY_PROVIDERS);

    expect(workflow).toContain(`|| '${scheduledMatrix}'`);
  });

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
  test("cycles through every curated model with supported roles", () => {
    for (const provider of CANARY_PROVIDERS) {
      const models = BYOK_MODEL_OPTIONS[provider];
      const rotations = models.map((_, rotationIndex) =>
        weeklyCanaryRotation({ provider, rotationIndex }),
      );

      expect(rotations.map(({ modelId }) => modelId)).toEqual([...models]);
      expect(
        weeklyCanaryRotation({
          provider,
          rotationIndex: models.length,
        }).modelId,
      ).toBe(models[0]);

      for (const { modelId, modelRoles } of rotations) {
        const supportedRoles = MODEL_ROLES.filter((role) =>
          isBYOKModelRoleSupported({ modelId, provider, role }),
        );
        const nonDefaultRoles = supportedRoles.filter(
          (role) => DEFAULT_MODELS[provider][role] !== modelId,
        );
        const expectedRoles =
          nonDefaultRoles.length > 0 ? nonDefaultRoles : supportedRoles;

        expect(modelRoles).toEqual(expectedRoles);
        for (const role of modelRoles) {
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
    ).toBe(WEEKLY_TOOL_SHAPES[0]);
  });

  test("rejects invalid rotation indexes", () => {
    expect(() =>
      weeklyCanaryRotation({ provider: "google", rotationIndex: -1 }),
    ).toThrow("Weekly canary rotation index must be non-negative.");
  });
});
