import { describe, expect, test } from "bun:test";

import { resolveTemperaturePolicy } from "./model-catalog-capabilities";
import { renderCapabilitiesModule } from "./model-catalog-capabilities-gen";

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
    ]);

    expect(source).toContain(
      '// override: 2026-08-20: reviewed source correction\n    "gpt-test",',
    );
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
