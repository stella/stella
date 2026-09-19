import { describe, expect, test } from "bun:test";

import type { OrgDecisionModelConfig } from "@/api/lib/ai-config";

import { resolveDecisionConfig } from "./ai-config-decision";

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
