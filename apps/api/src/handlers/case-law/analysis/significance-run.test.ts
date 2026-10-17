import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import type { DecisionAnalysisV3 } from "@stll/legal-ast/analysis";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";

import { refreshSignificance } from "./significance-run";

// A finished current-format analysis with no significance yet: exactly what a
// refresh would otherwise go on to write.
const analysis = {
  version: 3,
  generatedAt: "2026-10-12T09:00:00.000Z",
  model: "test-model",
  inputFingerprint: "fingerprint",
  tree: [],
  holding: { text: "Pravidlo.", language: "cs", anchors: [] },
  abstract: { text: "Abstrakt.", language: "cs" },
  topics: [],
} satisfies DecisionAnalysisV3;

// A fast-role key, so nothing but the deployment's own setting stands
// between this refresh and a model.
const orgAIConfig = {
  providers: [{ provider: "openai", apiKey: "test-api-key" }],
  overrideModels: {
    chat: { provider: "openai", modelId: "gpt-5.4-mini" },
    fast: { provider: "openai", modelId: "gpt-5.4-nano" },
    pdf: { provider: "openai", modelId: "gpt-5.4" },
    reasoning: { provider: "openai", modelId: "gpt-5.4" },
  },
  decision: null,
} satisfies OrgAIConfig;

describe("refreshing a decision's significance", () => {
  test("with derived AI off, asks no model", async () => {
    const admitted: string[] = [];

    await refreshSignificance({
      admitModelAction: async () => {
        admitted.push("admit");
        return panic("A refresh with derived AI off must not admit a model");
      },
      analysis,
      contentHash: null,
      decisionId: toSafeId<"caseLawDecision">(
        "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d",
      ),
      derivedAi: false,
      organizationId: toSafeId<"organization">("org_test"),
      orgAIConfig,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      promptCachingEnabled: false,
    });

    expect(admitted).toEqual([]);
  });
});
