import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";
import type { TanStackAIProvider } from "@stll/ai-catalog";

import { checkStructuredOutputBudget } from "@/api/lib/structured-output-budget";
import { buildBudgetEdgeSchema } from "@/api/lib/structured-output-budget-probe";
import { structuredOutputWireJsonSchema } from "@/api/lib/tanstack-ai-generate";

// Placeholder-budget providers are capped well under their published
// 100 000-byte ceiling (see `PLACEHOLDER_BUDGET_PROBE_MAX_BYTES`); the probe
// establishes its edge against this self-imposed cap, not the unknown ceiling.
const PLACEHOLDER_PROBE_CAP_BYTES = 20_000;

type Target = { provider: TanStackAIProvider; modelId: string };

const NATIVE_TARGETS: readonly Target[] = TANSTACK_AI_PROVIDERS.map(
  (provider) => ({ provider, modelId: `${provider}-canary-model` }),
);

// Two ids routed through an aggregator/platform to a provider with its own
// (real) budget: the edge these produce should match Anthropic's directly,
// not OpenRouter's or Bedrock's own placeholder.
const ROUTED_TARGETS: readonly Target[] = [
  { provider: "openrouter", modelId: "anthropic/claude-sonnet-5" },
  {
    provider: "bedrock",
    modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  },
];

describe("buildBudgetEdgeSchema", () => {
  test.each([...NATIVE_TARGETS, ...ROUTED_TARGETS])(
    "builds a schema that fits the resolved budget for %j",
    (target) => {
      const result = buildBudgetEdgeSchema(target);

      expect(result.propertyCount).toBeGreaterThan(0);

      // The builder's own stopping condition, re-verified through the exact
      // seam production requests pass through: the schema it hands back must
      // actually clear `checkStructuredOutputBudget`.
      const wireSchema = structuredOutputWireJsonSchema({
        outputSchema: result.outputSchema,
        provider: target.provider,
      });
      const check = checkStructuredOutputBudget({
        provider: target.provider,
        modelId: target.modelId,
        schema: wireSchema,
      });
      expect(Result.isOk(check)).toBe(true);
      expect(result.measured.unionParameters).toBeLessThanOrEqual(
        result.budget.maxUnionParameters,
      );
      expect(result.rejectedNext.propertyCount).toBe(result.propertyCount + 1);

      if (result.budget.basis === "placeholder") {
        expect(result.measured.bytes).toBeLessThanOrEqual(
          PLACEHOLDER_PROBE_CAP_BYTES,
        );
        expect(result.rejectedNext.reason).toBe("probe_cap");
        expect(result.rejectedNext.measured.bytes).toBeGreaterThan(
          PLACEHOLDER_PROBE_CAP_BYTES,
        );
        return;
      }

      expect(result.measured.bytes).toBeLessThanOrEqual(
        result.budget.maxSchemaBytes,
      );
      expect(result.rejectedNext.reason).toBe("provider_budget");
      expect(
        result.rejectedNext.measured.bytes > result.budget.maxSchemaBytes ||
          result.rejectedNext.measured.unionParameters >
            result.budget.maxUnionParameters,
      ).toBe(true);
    },
  );

  test("an OpenRouter id naming Anthropic resolves the same edge as calling Anthropic directly", () => {
    const routed = buildBudgetEdgeSchema({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-5",
    });
    const direct = buildBudgetEdgeSchema({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
    });

    expect(routed.compiler).toBe("anthropic");
    expect(routed.propertyCount).toBe(direct.propertyCount);
    expect(routed.budget).toEqual(direct.budget);
  });

  test("a Bedrock id naming Anthropic resolves the same edge as calling Anthropic directly", () => {
    const routed = buildBudgetEdgeSchema({
      provider: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    });
    const direct = buildBudgetEdgeSchema({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
    });

    expect(routed.compiler).toBe("anthropic");
    expect(routed.propertyCount).toBe(direct.propertyCount);
    expect(routed.budget).toEqual(direct.budget);
  });

  test("an OpenRouter id naming no known vendor keeps OpenRouter's own placeholder", () => {
    const result = buildBudgetEdgeSchema({
      provider: "openrouter",
      modelId: "some-vendor/unlisted-model",
    });

    expect(result.compiler).toBe("openrouter");
    expect(result.budget.basis).toBe("placeholder");
  });
});
