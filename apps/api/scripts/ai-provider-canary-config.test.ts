import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  BYOK_MODEL_OPTIONS,
  getOutputTokenLimit,
  isBYOKModelRoleSupported,
  MODEL_TASK_OVERRIDE_GROUP,
  MODEL_TASKS,
  resolveDefaultModel,
} from "@stll/ai-catalog";

import {
  CANARY_PROVIDERS,
  missingCanaryProviders,
  modelTaskMaxOutputTokens,
  structuredOutputBudgetEdgeMaxOutputTokens,
  structuredOutputModelTaskMaxOutputTokens,
  TOOL_CALL_PROBE_MAX_OUTPUT_TOKENS,
  WEEKLY_TOOL_SHAPES,
  weeklyCanaryRotation,
} from "./ai-provider-canary-config";

describe("AI provider canary task budgets", () => {
  const model = "model";

  test("caps every curated model's probes at its catalog output limit", () => {
    for (const provider of CANARY_PROVIDERS) {
      for (const modelId of BYOK_MODEL_OPTIONS[provider]) {
        const limit = getOutputTokenLimit(modelId);
        expect(limit).toBeDefined();
        if (limit === undefined) {
          panic(`Missing catalog output limit for ${modelId}`);
        }
        for (const task of MODEL_TASKS) {
          expect(
            modelTaskMaxOutputTokens({ modelId, task }),
          ).toBeLessThanOrEqual(limit);
          expect(
            structuredOutputModelTaskMaxOutputTokens({ modelId, task }),
          ).toBeLessThanOrEqual(limit);
        }
        expect(
          structuredOutputBudgetEdgeMaxOutputTokens({
            modelId,
            propertyCount: 1_000_000,
          }),
        ).toBe(limit);
        expect(TOOL_CALL_PROBE_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(limit);
      }
    }
  });

  test("keeps structured probes within the provider timeout envelope", () => {
    for (const task of MODEL_TASKS) {
      expect(
        structuredOutputModelTaskMaxOutputTokens({ modelId: model, task }),
      ).toBeLessThanOrEqual(modelTaskMaxOutputTokens({ modelId: model, task }));
    }

    expect(
      structuredOutputModelTaskMaxOutputTokens({
        modelId: model,
        task: "reasoning",
      }),
    ).toBeLessThan(21_000);
    expect(
      modelTaskMaxOutputTokens({ modelId: model, task: "reasoning" }),
    ).toBeGreaterThan(
      structuredOutputModelTaskMaxOutputTokens({
        modelId: model,
        task: "reasoning",
      }),
    );
  });

  test("budgets tool-execution probes above every short-reply task", () => {
    for (const task of MODEL_TASKS) {
      if (task === "reasoning") {
        continue;
      }
      expect(TOOL_CALL_PROBE_MAX_OUTPUT_TOKENS).toBeGreaterThan(
        modelTaskMaxOutputTokens({ modelId: model, task }),
      );
    }
    // Amazon Nova v1 accepts at most 10,000 output tokens and takes part in
    // the weekly rotation; a larger ceiling is rejected before the tool call.
    expect(TOOL_CALL_PROBE_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(10_000);
  });

  test("budgets the budget-edge probe above a truncating ceiling", () => {
    // A one-property schema still gets the tool-execution headroom: the
    // "short-text"-task default is a provider's smallest model, and a structured
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

  test("clamps task budgets to a model's output limit", () => {
    const nova = "us.amazon.nova-lite-v1:0";
    for (const task of MODEL_TASKS) {
      expect(
        modelTaskMaxOutputTokens({ modelId: nova, task }),
      ).toBeLessThanOrEqual(10_000);
      expect(
        structuredOutputModelTaskMaxOutputTokens({ modelId: nova, task }),
      ).toBeLessThanOrEqual(10_000);
    }
    expect(
      modelTaskMaxOutputTokens({ modelId: model, task: "reasoning" }),
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
    expect(
      workflow.match(
        /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/gu,
      ),
    ).toHaveLength(2);
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
  test("cycles through every curated model with supported tasks", () => {
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

      for (const { modelId, modelTasks } of rotations) {
        const supportedTasks = MODEL_TASKS.filter((task) =>
          isBYOKModelRoleSupported({
            modelId,
            provider,
            role: MODEL_TASK_OVERRIDE_GROUP[task],
          }),
        );
        const nonDefaultTasks = supportedTasks.filter(
          (task) =>
            (resolveDefaultModel({ task, orgProviders: [provider] })?.modelId ??
              null) !== modelId,
        );
        const expectedTasks =
          nonDefaultTasks.length > 0 ? nonDefaultTasks : supportedTasks;

        expect(modelTasks).toEqual(expectedTasks);
        for (const task of modelTasks) {
          expect(
            isBYOKModelRoleSupported({
              modelId,
              provider,
              role: MODEL_TASK_OVERRIDE_GROUP[task],
            }),
          ).toBe(true);
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
