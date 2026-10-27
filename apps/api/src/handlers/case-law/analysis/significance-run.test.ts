import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import type { DecisionAnalysisV4 } from "@stll/legal-ast/analysis";
import { isSignificanceCurrent } from "@stll/legal-ast/analysis";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import type { AnalysisStore } from "@/api/lib/case-law/analysis-store";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import type { CitationGraphFacts } from "./significance";
import {
  graphFingerprintOf,
  SIGNIFICANCE_PROMPT_VERSION,
} from "./significance";
import { refreshSignificance } from "./significance-run";

// A finished current-format analysis with no significance yet: exactly what a
// refresh would otherwise go on to write.
const analysis = {
  version: 4,
  generatedAt: "2026-10-12T09:00:00.000Z",
  model: "test-model",
  inputFingerprint: "fingerprint",
  tree: [],
  holding: { spans: [{ text: "Pravidlo.", anchors: [] }], language: "cs" },
  abstract: { spans: [{ text: "Abstrakt.", anchors: [] }], language: "cs" },
  topics: [],
} satisfies DecisionAnalysisV4;

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

  const decisionId = toSafeId<"caseLawDecision">(
    "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d",
  );
  // A decision no later court has cited.
  const uncited: CitationGraphFacts = {
    decisionId,
    citedByCount: 0,
    treatmentCounts: asTestRaw({}),
    countsByCourtTier: [],
    laterNegativeCount: 0,
    reportedInCollection: false,
    citingDecisionIds: [],
  };
  const uncitedFingerprint = graphFingerprintOf(uncited);
  const refreshUncited = async (stored: DecisionAnalysisV4) => {
    const saved: DecisionAnalysisV4[] = [];
    await refreshSignificance({
      admitModelAction: async () =>
        panic("An uncited decision must not admit a model"),
      analysis: stored,
      contentHash: null,
      decisionId,
      derivedAi: true,
      organizationId: toSafeId<"organization">("org_test"),
      orgAIConfig,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      promptCachingEnabled: false,
      readGraphFacts: async () => uncited,
      store: asTestRaw<AnalysisStore>({
        save: async ({
          analysis: written,
        }: {
          analysis: DecisionAnalysisV4;
        }) => {
          saved.push(written);
          return true;
        },
      }),
    });
    return saved;
  };

  test("with no citing decision, stores none from the graph without a model", async () => {
    const saved = await refreshUncited(analysis);

    expect(saved).toHaveLength(1);
    expect(saved[0]?.significance).toMatchObject({
      kind: "none",
      graphFingerprint: uncitedFingerprint,
    });
    expect(saved[0]?.holding).toEqual(analysis.holding);
  });

  test("replaces a statement a model wrote over an empty graph", async () => {
    const filler = {
      ...analysis,
      significance: {
        text: "Toto rozhodnutí nebylo dosud citováno.",
        language: "cs",
        graphFingerprint: uncitedFingerprint,
        generatedAt: "2026-10-12T09:00:00.000Z",
        model: "test-model",
        promptVersion: SIGNIFICANCE_PROMPT_VERSION,
      },
    } satisfies DecisionAnalysisV4;

    const saved = await refreshUncited(filler);

    expect(saved.map(({ significance }) => significance?.kind)).toEqual([
      "none",
    ]);
  });

  test("replaces a legacy statement when the organization has no classify model", async () => {
    const filler = {
      ...analysis,
      significance: {
        text: "Toto rozhodnutí nebylo dosud citováno.",
        language: "cs",
        graphFingerprint: uncitedFingerprint,
        generatedAt: "2026-10-12T09:00:00.000Z",
        model: "test-model",
        promptVersion: SIGNIFICANCE_PROMPT_VERSION,
      },
    } satisfies DecisionAnalysisV4;
    const saved: DecisionAnalysisV4[] = [];

    await refreshSignificance({
      admitModelAction: async () =>
        panic("An uncited decision must not admit a model"),
      analysis: filler,
      contentHash: null,
      decisionId,
      derivedAi: true,
      organizationId: toSafeId<"organization">("org_without_ai"),
      orgAIConfig: null,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      promptCachingEnabled: false,
      readGraphFacts: async () => uncited,
      store: asTestRaw<AnalysisStore>({
        save: async ({
          analysis: written,
        }: {
          analysis: DecisionAnalysisV4;
        }) => {
          saved.push(written);
          return true;
        },
      }),
    });

    expect(saved.map(({ significance }) => significance?.kind)).toEqual([
      "none",
    ]);
  });

  test("a stored none over the same graph stands and is not written again", async () => {
    const none = {
      ...analysis,
      significance: {
        kind: "none",
        graphFingerprint: uncitedFingerprint,
        generatedAt: "2026-10-12T09:00:00.000Z",
      },
    } satisfies DecisionAnalysisV4;

    expect(await refreshUncited(none)).toEqual([]);
    expect(
      isSignificanceCurrent({
        analysis: none,
        graphFingerprint: uncitedFingerprint,
        promptVersion: SIGNIFICANCE_PROMPT_VERSION,
      }),
    ).toBe(true);
    expect(
      isSignificanceCurrent({
        analysis: none,
        graphFingerprint: "a-citing-decision-arrived",
        promptVersion: SIGNIFICANCE_PROMPT_VERSION,
      }),
    ).toBe(false);
  });
});
