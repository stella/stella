import { describe, expect, test } from "bun:test";

import type { ReasoningEffort } from "@stll/ai-catalog";

import {
  parseUpstreamReasoning,
  validateReasoning,
} from "./model-catalog-reasoning";
import type { UpstreamReasoning } from "./model-catalog-reasoning";

const CHECKABLE = {
  google: "google",
  openrouter: "openrouter",
} as const;

const upstreamOf = (
  entries: Record<string, UpstreamReasoning>,
): ReadonlyMap<string, UpstreamReasoning> => new Map(Object.entries(entries));

describe("parseUpstreamReasoning", () => {
  test("extracts effort values from reasoning_options", () => {
    expect(
      parseUpstreamReasoning({
        reasoning: true,
        reasoning_options: [
          { type: "effort", values: ["minimal", "low", "medium", "high"] },
        ],
      }),
    ).toEqual({
      reasoning: true,
      effortValues: ["minimal", "low", "medium", "high"],
    });
  });

  test("treats budget-only and empty options as no effort control", () => {
    expect(
      parseUpstreamReasoning({
        reasoning: true,
        reasoning_options: [{ type: "budget_tokens", min: 1024 }],
      }),
    ).toEqual({ reasoning: true, effortValues: null });
    expect(
      parseUpstreamReasoning({ reasoning: true, reasoning_options: [] }),
    ).toEqual({ reasoning: true, effortValues: null });
    expect(parseUpstreamReasoning({ reasoning: false })).toEqual({
      reasoning: false,
      effortValues: null,
    });
  });

  test("returns null for records without reasoning metadata", () => {
    expect(parseUpstreamReasoning({})).toBeNull();
    expect(parseUpstreamReasoning("not-an-object")).toBeNull();
  });
});

describe("validateReasoning", () => {
  const declared: Record<string, readonly ReasoningEffort[] | null> = {
    "gemini-3.5-flash": ["minimal", "low", "medium", "high"],
    "openai/gpt-5.5": ["none", "low", "medium", "high", "xhigh"],
    "magistral-medium-latest": null,
  };

  test("passes when declarations match upstream", () => {
    const result = validateReasoning({
      entries: [
        { provider: "google", modelId: "gemini-3.5-flash" },
        { provider: "openrouter", modelId: "openai/gpt-5.5" },
      ],
      checkableProviders: CHECKABLE,
      upstream: upstreamOf({
        "google:gemini-3.5-flash": {
          reasoning: true,
          effortValues: ["minimal", "low", "medium", "high"],
        },
        "openrouter:openai/gpt-5.5": {
          reasoning: true,
          effortValues: ["none", "low", "medium", "high", "xhigh"],
        },
      }),
      declared,
    });
    expect(result.failures).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test("flags a model whose reasoning became mandatory upstream", () => {
    // The class this check exists for: "none" disappears from the
    // published values while the declaration still allows it.
    const result = validateReasoning({
      entries: [{ provider: "openrouter", modelId: "openai/gpt-5.5" }],
      checkableProviders: CHECKABLE,
      upstream: upstreamOf({
        "openrouter:openai/gpt-5.5": {
          reasoning: true,
          effortValues: ["low", "medium", "high", "xhigh"],
        },
      }),
      declared,
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures.at(0)?.label).toBe("REASONING DRIFT");
  });

  test("flags drift between a null declaration and an upstream effort dial", () => {
    const result = validateReasoning({
      entries: [{ provider: "google", modelId: "magistral-medium-latest" }],
      checkableProviders: CHECKABLE,
      upstream: upstreamOf({
        "google:magistral-medium-latest": {
          reasoning: true,
          effortValues: ["none", "high"],
        },
      }),
      declared,
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures.at(0)?.label).toBe("REASONING DRIFT");
  });

  test("accepts a null declaration for a non-reasoning upstream model", () => {
    const result = validateReasoning({
      entries: [{ provider: "google", modelId: "magistral-medium-latest" }],
      checkableProviders: CHECKABLE,
      upstream: upstreamOf({
        "google:magistral-medium-latest": {
          reasoning: false,
          effortValues: null,
        },
      }),
      declared,
    });
    expect(result.failures).toEqual([]);
  });

  test("fails coverage for an offered model without a declaration", () => {
    const result = validateReasoning({
      entries: [{ provider: "google", modelId: "gemini-brand-new" }],
      checkableProviders: CHECKABLE,
      upstream: upstreamOf({}),
      declared,
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures.at(0)?.label).toBe("NO REASONING CAPABILITY");
  });

  test("skips models without upstream reasoning metadata and uncheckable providers", () => {
    const result = validateReasoning({
      entries: [
        { provider: "google", modelId: "gemini-3.5-flash" },
        { provider: "bedrock", modelId: "us.deepseek.r1-v1:0" },
      ],
      checkableProviders: CHECKABLE,
      upstream: upstreamOf({}),
      declared,
    });
    expect(result.failures).toEqual([]);
    expect(result.skipped).toEqual([
      { provider: "google", modelId: "gemini-3.5-flash" },
    ]);
  });
});
