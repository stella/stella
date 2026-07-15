import { describe, expect, test } from "bun:test";

import { MODEL_ROLES } from "@stll/ai-catalog";

import {
  CANARY_PROVIDERS,
  missingCanaryProviders,
  modelRoleMaxOutputTokens,
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
