import { describe, expect, test } from "bun:test";

import type { OrgDecisionModelConfig } from "@/api/lib/ai-config";

import { resolveDecisionConfig as resolve } from "./ai-config-decision";

const resolveDecisionConfig = (
  input: Parameters<typeof resolve>[0]["input"],
  existing: OrgDecisionModelConfig | null,
) => {
  const result = resolve({
    input,
    existing,
    providers: [],
    existingProviders: [],
  });
  if (!result.valid || !result.needsProbe) {
    return result;
  }
  const { probeConfig, ...rest } = result;
  expect(probeConfig.apiKey).toBe(rest.decision.apiKey);
  return rest;
};

const stored: OrgDecisionModelConfig = {
  provider: "typesafe",
  apiKey: "stored-key",
  modelId: "jev-1.13",
};

describe("resolving the decision model an AI-config update stores", () => {
  test("an absent field keeps the stored decision model", () => {
    expect(resolveDecisionConfig(undefined, stored)).toEqual({
      valid: true,
      decision: stored,
      needsProbe: false,
    });
  });

  test("an absent field on an org that never had one stays none", () => {
    expect(resolveDecisionConfig(undefined, null)).toEqual({
      valid: true,
      decision: null,
      needsProbe: false,
    });
  });

  test("null clears the stored decision model", () => {
    expect(resolveDecisionConfig(null, stored)).toEqual({
      valid: true,
      decision: null,
      needsProbe: false,
    });
  });

  test("a supplied key replaces the stored one and is flagged for probing", () => {
    expect(
      resolveDecisionConfig(
        { provider: "typesafe", apiKey: "new-key", modelId: "jev-1.14" },
        stored,
      ),
    ).toEqual({
      valid: true,
      decision: {
        provider: "typesafe",
        apiKey: "new-key",
        modelId: "jev-1.14",
      },
      needsProbe: true,
    });
  });

  test("an omitted key reuses the stored one and probes a changed model", () => {
    expect(
      resolveDecisionConfig(
        { provider: "typesafe", modelId: "jev-1.14" },
        stored,
      ),
    ).toEqual({
      valid: true,
      decision: {
        provider: "typesafe",
        apiKey: "stored-key",
        modelId: "jev-1.14",
      },
      needsProbe: true,
    });
  });

  test("an unchanged model and omitted key do not repeat the probe", () => {
    expect(
      resolveDecisionConfig(
        { provider: "typesafe", modelId: "jev-1.13" },
        stored,
      ),
    ).toEqual({
      valid: true,
      decision: stored,
      needsProbe: false,
    });
  });

  test("an omitted key with nothing stored is rejected", () => {
    expect(
      resolveDecisionConfig(
        { provider: "typesafe", modelId: "jev-1.14" },
        null,
      ),
    ).toEqual({
      valid: false,
      error: "API key is required for the decision model",
    });
  });

  test("a whitespace-only key is no key at all", () => {
    expect(
      resolveDecisionConfig(
        { provider: "typesafe", apiKey: "   ", modelId: "jev-1.14" },
        null,
      ),
    ).toEqual({
      valid: false,
      error: "API key is required for the decision model",
    });
  });

  test("the model id is trimmed, and a blank one is rejected", () => {
    expect(
      resolveDecisionConfig(
        { provider: "typesafe", apiKey: "new-key", modelId: "  jev-1.14  " },
        null,
      ),
    ).toEqual({
      valid: true,
      decision: {
        provider: "typesafe",
        apiKey: "new-key",
        modelId: "jev-1.14",
      },
      needsProbe: true,
    });
    expect(
      resolveDecisionConfig(
        { provider: "typesafe", apiKey: "new-key", modelId: "   " },
        stored,
      ),
    ).toEqual({
      valid: false,
      error: "A model is required for the decision model",
    });
  });
});

const openaiProvider = {
  provider: "openai",
  apiKey: "org-openai",
  region: "global",
} as const;
const openaiDecision = {
  provider: "openai",
  region: "eu",
  modelId: "gpt-6-luna",
} as const;
describe("OpenAI decision key ownership", () => {
  test("defaults to the current generative OpenAI key and EU endpoint", () => {
    expect(
      resolve({
        input: { provider: "openai", modelId: "gpt-6-luna" },
        existing: stored,
        providers: [openaiProvider],
        existingProviders: [],
      }),
    ).toEqual({
      valid: true,
      decision: openaiDecision,
      needsProbe: true,
      probeConfig: { ...openaiDecision, apiKey: "org-openai" },
    });
  });
  test("never reuses another provider's key", () => {
    expect(
      resolve({
        input: openaiDecision,
        existing: stored,
        providers: [{ provider: "anthropic", apiKey: "other" }],
        existingProviders: [],
      }),
    ).toEqual({
      valid: false,
      error:
        "The decision model reuses your OpenAI API key. Keep that provider and key, add a separate decision API key, or switch the decision provider.",
    });
  });
  test("an override survives omitted edits, and null returns to reuse", () => {
    const existing = { ...openaiDecision, apiKey: "override" };
    expect(
      resolve({
        input: openaiDecision,
        existing,
        providers: [openaiProvider],
        existingProviders: [openaiProvider],
      }),
    ).toEqual({ valid: true, decision: existing, needsProbe: false });
    expect(
      resolve({
        input: { ...openaiDecision, apiKey: null },
        existing,
        providers: [openaiProvider],
        existingProviders: [openaiProvider],
      }),
    ).toEqual({
      valid: true,
      decision: openaiDecision,
      needsProbe: true,
      probeConfig: { ...openaiDecision, apiKey: "org-openai" },
    });
  });
  test("a rotated reused key probes even when the decision field is omitted", () => {
    expect(
      resolve({
        input: undefined,
        existing: openaiDecision,
        providers: [{ ...openaiProvider, apiKey: "rotated" }],
        existingProviders: [openaiProvider],
      }),
    ).toEqual({
      valid: true,
      decision: openaiDecision,
      needsProbe: true,
      probeConfig: { ...openaiDecision, apiKey: "rotated" },
    });
  });
  test.each([
    { providers: [] },
    { providers: [{ ...openaiProvider, apiKey: "" }] },
  ])(
    "removing the reused provider or its key fails while an override remains usable (%j)",
    ({ providers }) => {
      expect(
        resolve({
          input: undefined,
          existing: openaiDecision,
          providers,
          existingProviders: [openaiProvider],
        }).valid,
      ).toBe(false);
      expect(
        resolve({
          input: undefined,
          existing: { ...openaiDecision, apiKey: "override" },
          providers,
          existingProviders: [openaiProvider],
        }).valid,
      ).toBe(true);
    },
  );
  test("region changes require a decision probe", () => {
    expect(
      resolve({
        input: { ...openaiDecision, region: "global" },
        existing: openaiDecision,
        providers: [openaiProvider],
        existingProviders: [openaiProvider],
      }),
    ).toEqual({
      valid: true,
      decision: { ...openaiDecision, region: "global" },
      needsProbe: true,
      probeConfig: {
        ...openaiDecision,
        region: "global",
        apiKey: "org-openai",
      },
    });
  });
});
