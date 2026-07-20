import { describe, expect, test } from "bun:test";

import type { ReasoningEffort } from "@stll/ai-catalog";

import {
  parseUpstreamCapabilities,
  validateCapabilities,
} from "./model-catalog-capabilities";
import type { UpstreamCapabilities } from "./model-catalog-capabilities";

const CHECKABLE = {
  google: "google",
  openrouter: "openrouter",
} as const;

const upstreamOf = (
  entries: Record<string, UpstreamCapabilities>,
): ReadonlyMap<string, UpstreamCapabilities> =>
  new Map(Object.entries(entries));

const DECLARED_EFFORTS: Record<string, readonly ReasoningEffort[] | null> = {
  "gemini-3.5-flash": ["minimal", "low", "medium", "high"],
  "openai/gpt-5.5": ["none", "low", "medium", "high", "xhigh"],
  "magistral-medium-latest": null,
};

const DECLARED_TEMPERATURE: Record<string, boolean> = {
  "gemini-3.5-flash": true,
  "openai/gpt-5.5": false,
  "magistral-medium-latest": true,
};

describe("parseUpstreamCapabilities", () => {
  test("extracts effort values and temperature support", () => {
    expect(
      parseUpstreamCapabilities({
        reasoning: true,
        temperature: false,
        reasoning_options: [
          { type: "effort", values: ["minimal", "low", "medium", "high"] },
        ],
      }),
    ).toEqual({
      reasoning: true,
      effortValues: ["minimal", "low", "medium", "high"],
      temperature: false,
    });
  });

  test("treats budget-only and empty options as no effort control", () => {
    expect(
      parseUpstreamCapabilities({
        reasoning: true,
        reasoning_options: [{ type: "budget_tokens", min: 1024 }],
      }),
    ).toEqual({ reasoning: true, effortValues: null, temperature: null });
    expect(
      parseUpstreamCapabilities({ reasoning: false, temperature: true }),
    ).toEqual({ reasoning: false, effortValues: null, temperature: true });
  });

  test("returns null for records without reasoning metadata", () => {
    expect(parseUpstreamCapabilities({})).toBeNull();
    expect(parseUpstreamCapabilities("not-an-object")).toBeNull();
  });

  test("folds a toggle option into the effort set as none", () => {
    // A separate { type: "toggle" } means reasoning can be disabled
    // even when the effort list omits "none"; without the fold, a
    // representational shift upstream would read as false drift.
    expect(
      parseUpstreamCapabilities({
        reasoning: true,
        reasoning_options: [
          { type: "toggle" },
          { type: "effort", values: ["low", "medium", "high"] },
        ],
      }),
    ).toEqual({
      reasoning: true,
      effortValues: ["none", "low", "medium", "high"],
      temperature: null,
    });
    // Toggle-only models have no effort vocabulary to send.
    expect(
      parseUpstreamCapabilities({
        reasoning: true,
        reasoning_options: [{ type: "toggle" }],
      }),
    ).toEqual({ reasoning: true, effortValues: null, temperature: null });
    // No duplicate "none" when the effort list already has it.
    expect(
      parseUpstreamCapabilities({
        reasoning: true,
        reasoning_options: [
          { type: "toggle" },
          { type: "effort", values: ["none", "high"] },
        ],
      }),
    ).toEqual({
      reasoning: true,
      effortValues: ["none", "high"],
      temperature: null,
    });
  });
});

describe("validateCapabilities", () => {
  const validUpstream = upstreamOf({
    "google:gemini-3.5-flash": {
      reasoning: true,
      effortValues: ["minimal", "low", "medium", "high"],
      temperature: true,
    },
    "openrouter:openai/gpt-5.5": {
      reasoning: true,
      effortValues: ["none", "low", "medium", "high", "xhigh"],
      temperature: false,
    },
  });

  test("passes when declarations match upstream", () => {
    const result = validateCapabilities({
      entries: [
        { provider: "google", modelId: "gemini-3.5-flash" },
        { provider: "openrouter", modelId: "openai/gpt-5.5" },
      ],
      checkableProviders: CHECKABLE,
      upstream: validUpstream,
      declaredEfforts: DECLARED_EFFORTS,
      declaredTemperature: DECLARED_TEMPERATURE,
    });
    expect(result.failures).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test("flags a model whose reasoning became mandatory upstream", () => {
    // The class this check exists for: "none" disappears from the
    // published values while the declaration still allows it.
    const result = validateCapabilities({
      entries: [{ provider: "openrouter", modelId: "openai/gpt-5.5" }],
      checkableProviders: CHECKABLE,
      upstream: upstreamOf({
        "openrouter:openai/gpt-5.5": {
          reasoning: true,
          effortValues: ["low", "medium", "high", "xhigh"],
          temperature: false,
        },
      }),
      declaredEfforts: DECLARED_EFFORTS,
      declaredTemperature: DECLARED_TEMPERATURE,
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures.at(0)?.label).toBe("REASONING DRIFT");
  });

  test("flags drift between a null declaration and an upstream effort dial", () => {
    const result = validateCapabilities({
      entries: [{ provider: "google", modelId: "magistral-medium-latest" }],
      checkableProviders: CHECKABLE,
      upstream: upstreamOf({
        "google:magistral-medium-latest": {
          reasoning: true,
          effortValues: ["none", "high"],
          temperature: true,
        },
      }),
      declaredEfforts: DECLARED_EFFORTS,
      declaredTemperature: DECLARED_TEMPERATURE,
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures.at(0)?.label).toBe("REASONING DRIFT");
  });

  test("flags a model whose temperature support flipped upstream", () => {
    const result = validateCapabilities({
      entries: [{ provider: "google", modelId: "gemini-3.5-flash" }],
      checkableProviders: CHECKABLE,
      upstream: upstreamOf({
        "google:gemini-3.5-flash": {
          reasoning: true,
          effortValues: ["minimal", "low", "medium", "high"],
          temperature: false,
        },
      }),
      declaredEfforts: DECLARED_EFFORTS,
      declaredTemperature: DECLARED_TEMPERATURE,
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures.at(0)?.label).toBe("TEMPERATURE DRIFT");
  });

  test("does not flag temperature when upstream publishes none", () => {
    const result = validateCapabilities({
      entries: [{ provider: "google", modelId: "magistral-medium-latest" }],
      checkableProviders: CHECKABLE,
      upstream: upstreamOf({
        "google:magistral-medium-latest": {
          reasoning: false,
          effortValues: null,
          temperature: null,
        },
      }),
      declaredEfforts: DECLARED_EFFORTS,
      declaredTemperature: DECLARED_TEMPERATURE,
    });
    expect(result.failures).toEqual([]);
  });

  test("fails coverage for offered models missing either declaration", () => {
    const efforts = validateCapabilities({
      entries: [{ provider: "google", modelId: "gemini-brand-new" }],
      checkableProviders: CHECKABLE,
      upstream: upstreamOf({}),
      declaredEfforts: DECLARED_EFFORTS,
      declaredTemperature: DECLARED_TEMPERATURE,
    });
    expect(efforts.failures.at(0)?.label).toBe("NO REASONING CAPABILITY");

    const temperature = validateCapabilities({
      entries: [{ provider: "google", modelId: "gemini-3.5-flash" }],
      checkableProviders: CHECKABLE,
      upstream: validUpstream,
      declaredEfforts: DECLARED_EFFORTS,
      declaredTemperature: {},
    });
    expect(temperature.failures.at(0)?.label).toBe("NO TEMPERATURE CAPABILITY");
  });

  test("skips models without upstream metadata and uncheckable providers", () => {
    const result = validateCapabilities({
      entries: [
        { provider: "google", modelId: "gemini-3.5-flash" },
        { provider: "bedrock", modelId: "us.deepseek.r1-v1:0" },
      ],
      checkableProviders: CHECKABLE,
      upstream: upstreamOf({}),
      declaredEfforts: DECLARED_EFFORTS,
      declaredTemperature: DECLARED_TEMPERATURE,
    });
    expect(result.failures).toEqual([]);
    expect(result.skipped).toEqual([
      { provider: "google", modelId: "gemini-3.5-flash" },
    ]);
  });

  test("silently skips override-declared ids instead of warning nightly", () => {
    const result = validateCapabilities({
      entries: [{ provider: "google", modelId: "gemini-3.5-flash" }],
      checkableProviders: CHECKABLE,
      upstream: upstreamOf({}),
      declaredEfforts: DECLARED_EFFORTS,
      declaredTemperature: DECLARED_TEMPERATURE,
      overriddenIds: new Set(["gemini-3.5-flash"]),
    });
    expect(result.failures).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});
