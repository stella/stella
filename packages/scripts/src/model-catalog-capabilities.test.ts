import { describe, expect, test } from "bun:test";

import type { ReasoningEffort, TemperaturePolicy } from "@stll/ai-catalog";

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

const DECLARED_TEMPERATURE_POLICIES: Record<string, TemperaturePolicy> = {
  "gemini-3.5-flash": "emit",
  "openai/gpt-5.5": "omit",
  "magistral-medium-latest": "emit",
};

describe("parseUpstreamCapabilities", () => {
  test("extracts effort values and temperature support", () => {
    expect(
      parseUpstreamCapabilities({
        release_date: "2026-07-21",
        reasoning: true,
        temperature: false,
        reasoning_options: [
          { type: "effort", values: ["minimal", "low", "medium", "high"] },
        ],
      }),
    ).toEqual({
      releaseDate: "2026-07-21",
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
    ).toEqual({
      releaseDate: null,
      reasoning: true,
      effortValues: null,
      temperature: null,
    });
    expect(
      parseUpstreamCapabilities({ reasoning: false, temperature: true }),
    ).toEqual({
      releaseDate: null,
      reasoning: false,
      effortValues: null,
      temperature: true,
    });
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
      releaseDate: null,
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
    ).toEqual({
      releaseDate: null,
      reasoning: true,
      effortValues: null,
      temperature: null,
    });
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
      releaseDate: null,
      reasoning: true,
      effortValues: ["none", "high"],
      temperature: null,
    });
  });
});

describe("validateCapabilities", () => {
  const validUpstream = upstreamOf({
    "google:gemini-3.5-flash": {
      releaseDate: "2026-05-01",
      reasoning: true,
      effortValues: ["minimal", "low", "medium", "high"],
      temperature: true,
    },
    "openrouter:openai/gpt-5.5": {
      releaseDate: "2026-06-01",
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
      declaredTemperaturePolicies: DECLARED_TEMPERATURE_POLICIES,
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
          releaseDate: "2026-06-01",
          reasoning: true,
          effortValues: ["low", "medium", "high", "xhigh"],
          temperature: false,
        },
      }),
      declaredEfforts: DECLARED_EFFORTS,
      declaredTemperaturePolicies: DECLARED_TEMPERATURE_POLICIES,
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
          releaseDate: "2026-01-01",
          reasoning: true,
          effortValues: ["none", "high"],
          temperature: true,
        },
      }),
      declaredEfforts: DECLARED_EFFORTS,
      declaredTemperaturePolicies: DECLARED_TEMPERATURE_POLICIES,
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures.at(0)?.label).toBe("REASONING DRIFT");
  });

  test("flags emit when upstream no longer supports temperature", () => {
    const result = validateCapabilities({
      entries: [{ provider: "google", modelId: "gemini-3.5-flash" }],
      checkableProviders: CHECKABLE,
      upstream: upstreamOf({
        "google:gemini-3.5-flash": {
          releaseDate: "2026-05-01",
          reasoning: true,
          effortValues: ["minimal", "low", "medium", "high"],
          temperature: false,
        },
      }),
      declaredEfforts: DECLARED_EFFORTS,
      declaredTemperaturePolicies: DECLARED_TEMPERATURE_POLICIES,
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures.at(0)?.label).toBe("UNSAFE TEMPERATURE POLICY");
  });

  test("flags emit after the reviewed Google temperature cutoff", () => {
    const declaredTemperaturePolicies = {
      ...DECLARED_TEMPERATURE_POLICIES,
      "gemini-3.6-flash": "emit",
      "google/gemini-3.6-flash": "emit",
    } as const satisfies Record<string, TemperaturePolicy>;
    const result = validateCapabilities({
      entries: [
        { provider: "google", modelId: "gemini-3.6-flash" },
        { provider: "openrouter", modelId: "google/gemini-3.6-flash" },
      ],
      checkableProviders: CHECKABLE,
      upstream: upstreamOf({
        "google:gemini-3.6-flash": {
          releaseDate: "2026-07-21",
          reasoning: true,
          effortValues: null,
          temperature: true,
        },
        "openrouter:google/gemini-3.6-flash": {
          releaseDate: "2026-07-21",
          reasoning: true,
          effortValues: null,
          temperature: true,
        },
      }),
      declaredEfforts: {
        ...DECLARED_EFFORTS,
        "gemini-3.6-flash": null,
        "google/gemini-3.6-flash": null,
      },
      declaredTemperaturePolicies,
    });
    expect(result.failures.map(({ label }) => label)).toEqual([
      "UNSAFE TEMPERATURE POLICY",
      "UNSAFE TEMPERATURE POLICY",
    ]);
  });

  test("allows omit when upstream still accepts an ignored parameter", () => {
    const result = validateCapabilities({
      entries: [{ provider: "openrouter", modelId: "openai/gpt-5.5" }],
      checkableProviders: CHECKABLE,
      upstream: upstreamOf({
        "openrouter:openai/gpt-5.5": {
          releaseDate: "2026-06-01",
          reasoning: true,
          effortValues: ["none", "low", "medium", "high", "xhigh"],
          temperature: true,
        },
      }),
      declaredEfforts: DECLARED_EFFORTS,
      declaredTemperaturePolicies: DECLARED_TEMPERATURE_POLICIES,
    });
    expect(result.failures).toEqual([]);
  });

  test("flags emit when upstream publishes no temperature metadata", () => {
    const result = validateCapabilities({
      entries: [{ provider: "google", modelId: "magistral-medium-latest" }],
      checkableProviders: CHECKABLE,
      upstream: upstreamOf({
        "google:magistral-medium-latest": {
          releaseDate: "2026-01-01",
          reasoning: false,
          effortValues: null,
          temperature: null,
        },
      }),
      declaredEfforts: DECLARED_EFFORTS,
      declaredTemperaturePolicies: DECLARED_TEMPERATURE_POLICIES,
    });
    expect(result.failures.at(0)?.label).toBe("UNSAFE TEMPERATURE POLICY");
  });

  test("fails coverage for offered models missing either declaration", () => {
    const efforts = validateCapabilities({
      entries: [{ provider: "google", modelId: "gemini-brand-new" }],
      checkableProviders: CHECKABLE,
      upstream: upstreamOf({}),
      declaredEfforts: DECLARED_EFFORTS,
      declaredTemperaturePolicies: DECLARED_TEMPERATURE_POLICIES,
    });
    expect(efforts.failures.at(0)?.label).toBe("NO REASONING CAPABILITY");

    const temperature = validateCapabilities({
      entries: [{ provider: "google", modelId: "gemini-3.5-flash" }],
      checkableProviders: CHECKABLE,
      upstream: validUpstream,
      declaredEfforts: DECLARED_EFFORTS,
      declaredTemperaturePolicies: {},
    });
    expect(temperature.failures.at(0)?.label).toBe("NO TEMPERATURE POLICY");
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
      declaredTemperaturePolicies: DECLARED_TEMPERATURE_POLICIES,
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
      declaredTemperaturePolicies: DECLARED_TEMPERATURE_POLICIES,
      overriddenIds: new Set(["gemini-3.5-flash"]),
    });
    expect(result.failures).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});
