import { describe, expect, test } from "bun:test";

import { BYOK_MODEL_OPTIONS, TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";

import { resolveTemperaturePolicy } from "./model-catalog-capabilities";
import type { UpstreamCapabilities } from "./model-catalog-capabilities";
import {
  MODELS_DEV_KEY_BY_PROVIDER,
  buildCapabilityRows,
  renderCapabilitiesModule,
} from "./model-catalog-capabilities-gen";

const offeredModelIds = TANSTACK_AI_PROVIDERS.flatMap((provider) =>
  BYOK_MODEL_OPTIONS[provider].map((modelId) => ({ provider, modelId })),
);

const upstreamWithToolCall = (
  toolCallFor: (modelId: string) => boolean | null,
): ReadonlyMap<string, UpstreamCapabilities> =>
  new Map(
    offeredModelIds.map(({ provider, modelId }) => [
      `${MODELS_DEV_KEY_BY_PROVIDER[provider]}:${modelId}`,
      {
        releaseDate: null,
        reasoning: false,
        effortValues: null,
        inputModalities: ["text"],
        temperature: false,
        toolCall: toolCallFor(modelId),
      },
    ]),
  );

describe("tool-calling requirement", () => {
  const toolLessModelId = BYOK_MODEL_OPTIONS.bedrock.at(-1) ?? "";

  test("generates a row for every offered model that accepts tools", () => {
    const rows = buildCapabilityRows({
      openRouterDefaults: new Map(),
      upstream: upstreamWithToolCall(() => true),
    });
    expect(rows.map((row) => row.modelId)).toEqual(
      offeredModelIds.map(({ modelId }) => modelId),
    );
  });

  test("rejects an offered model that cannot take tools", () => {
    expect(() =>
      buildCapabilityRows({
        openRouterDefaults: new Map(),
        upstream: upstreamWithToolCall(
          (modelId) => modelId !== toolLessModelId,
        ),
      }),
    ).toThrow(`bedrock/${toolLessModelId}: models.dev reports no tool calling`);
  });

  test("rejects a record that does not publish tool support", () => {
    expect(() =>
      buildCapabilityRows({
        openRouterDefaults: new Map(),
        upstream: upstreamWithToolCall((modelId) =>
          modelId === toolLessModelId ? null : true,
        ),
      }),
    ).toThrow("lacks the tool_call field");
  });
});

describe("capability module generation", () => {
  test("emits document-input models, source corrections, and empty providers", () => {
    const source = renderCapabilitiesModule([
      {
        defaultReasoningEffort: null,
        documentInput: true,
        documentInputOverrideReason: "2026-08-20: reviewed source correction",
        efforts: null,
        modelId: "gpt-test",
        overrideReason: null,
        provider: "openai",
        temperaturePolicy: "omit",
      },
      {
        defaultReasoningEffort: null,
        documentInput: false,
        documentInputOverrideReason: null,
        efforts: null,
        modelId: "gpt-text-only",
        overrideReason: null,
        provider: "openai",
        temperaturePolicy: "omit",
      },
    ]);

    expect(source).toContain(
      '// override: 2026-08-20: reviewed source correction\n    "gpt-test",',
    );
    expect(source).not.toContain('    "gpt-text-only",');
    expect(source).toContain("mistral: []");
  });
});

describe("temperature emission policy", () => {
  test("omits deprecated sampling parameters for the Gemini cutoff and future releases", () => {
    expect(
      resolveTemperaturePolicy({
        modelId: "gemini-3.5-flash",
        provider: "google",
        releaseDate: "2026-05-20",
        upstreamSupportsTemperature: true,
      }),
    ).toBe("emit");

    for (const candidate of [
      {
        modelId: "gemini-3.5-flash-lite",
        provider: "google" as const,
      },
      {
        modelId: "google/gemini-3.6-flash",
        provider: "openrouter" as const,
      },
      {
        modelId: "gemini-4.0-flash",
        provider: "google" as const,
      },
    ]) {
      expect(
        resolveTemperaturePolicy({
          ...candidate,
          releaseDate: "2026-07-21",
          upstreamSupportsTemperature: true,
        }),
        `${candidate.provider}/${candidate.modelId}`,
      ).toBe("omit");
    }
  });

  test("requires a release date before emitting temperature for Google models", () => {
    expect(() =>
      resolveTemperaturePolicy({
        modelId: "gemini-future",
        provider: "google",
        releaseDate: null,
        upstreamSupportsTemperature: true,
      }),
    ).toThrow("lacks a valid release_date");
  });

  test("omits rejected parameters and preserves supported non-Google parameters", () => {
    expect(
      resolveTemperaturePolicy({
        modelId: "claude-example",
        provider: "anthropic",
        releaseDate: null,
        upstreamSupportsTemperature: false,
      }),
    ).toBe("omit");
    expect(
      resolveTemperaturePolicy({
        modelId: "mistral-example",
        provider: "mistral",
        releaseDate: null,
        upstreamSupportsTemperature: true,
      }),
    ).toBe("emit");
  });
});
