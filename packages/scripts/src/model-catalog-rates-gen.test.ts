import { describe, expect, test } from "bun:test";

import type { GeneratedModelRateRow } from "./model-catalog-rates-gen";
import {
  modelRateFromModelsDev,
  renderModelRatesModule,
} from "./model-catalog-rates-gen";

const model = (cost: Record<string, unknown>): unknown => ({ cost });

describe("models.dev rate conversion", () => {
  test("converts decimal USD prices exactly, including sub-cent rates", () => {
    expect(
      modelRateFromModelsDev(
        model({ input: 0.00875, output: 0.03125 }),
        "openai:gpt-test",
      ),
    ).toEqual({
      kind: "flat",
      inputPerMTok: 875,
      outputPerMTok: 3125,
    });
  });

  test("retains exact cache-read pricing", () => {
    expect(
      modelRateFromModelsDev(
        model({
          input: 0.25,
          output: 1,
          cache_read: 0.0125,
          cache_write: 0.3125,
        }),
        "anthropic:claude-test",
      ),
    ).toEqual({
      kind: "flat",
      inputPerMTok: 25_000,
      outputPerMTok: 100_000,
      cachedInputPerMTok: 1250,
      cachedWriteInputPerMTok: 31_250,
    });
  });

  test("accepts the known audio-input axis without adding it to token rates", () => {
    expect(
      modelRateFromModelsDev(
        model({ input: 0.25, output: 1, input_audio: 0.5 }),
        "google:gemini-test",
      ),
    ).toEqual({
      kind: "flat",
      inputPerMTok: 25_000,
      outputPerMTok: 100_000,
    });
  });

  test("rejects prices below the ledger's exact decimal resolution", () => {
    expect(() =>
      modelRateFromModelsDev(
        model({ input: 0.000001, output: 1 }),
        "openai:gpt-test",
      ),
    ).toThrow("does not map to an exact safe integer");
  });

  test("converts one context tier into a complete schedule", () => {
    expect(
      modelRateFromModelsDev(
        model({
          input: 1,
          output: 4,
          cache_read: 0.1,
          cache_write: 1.25,
          tiers: [
            {
              tier: { type: "context", size: 200_000 },
              input: 2,
              output: 8,
              cache_read: 0.2,
              cache_write: 2.5,
            },
          ],
        }),
        "openai:gpt-tiered",
      ),
    ).toEqual({
      kind: "input-token-tiered",
      inputTokenThreshold: 200_000,
      standard: {
        inputPerMTok: 100_000,
        outputPerMTok: 400_000,
        cachedInputPerMTok: 10_000,
        cachedWriteInputPerMTok: 125_000,
      },
      aboveThreshold: {
        inputPerMTok: 200_000,
        outputPerMTok: 800_000,
        cachedInputPerMTok: 20_000,
        cachedWriteInputPerMTok: 250_000,
      },
    });
  });

  test("requires the legacy long-context mirror to equal the tier", () => {
    expect(() =>
      modelRateFromModelsDev(
        model({
          input: 1,
          output: 4,
          context_over_200k: { input: 2, output: 7 },
          tiers: [
            {
              tier: { type: "context", size: 200_000 },
              input: 2,
              output: 8,
            },
          ],
        }),
        "google:gemini-tiered",
      ),
    ).toThrow("context_over_200k disagrees");

    expect(() =>
      modelRateFromModelsDev(
        model({
          input: 1,
          output: 4,
          context_over_200k: { input: 2, output: 8 },
          tiers: [],
        }),
        "google:gemini-tiered",
      ),
    ).toThrow("context_over_200k exists without a supported context tier");
  });

  test("rejects unknown cost axes", () => {
    expect(() =>
      modelRateFromModelsDev(
        model({ input: 1, output: 4, output_audio: 8 }),
        "google:gemini-test",
      ),
    ).toThrow("unsupported models.dev cost fields: output_audio");
  });

  test.each([
    ["missing cost object", {}, "has no cost object"],
    ["missing input", { cost: { output: 1 } }, "cost.input"],
    ["missing output", { cost: { input: 1 } }, "cost.output"],
    [
      "malformed tier",
      { cost: { input: 1, output: 2, tiers: [{}] } },
      "tiers[0]",
    ],
  ])("rejects %s", (_label, value, message) => {
    expect(() => modelRateFromModelsDev(value, "google:model-test")).toThrow(
      message,
    );
  });

  test("rejects unsupported and multiple context tiers", () => {
    expect(() =>
      modelRateFromModelsDev(
        model({
          input: 1,
          output: 2,
          tiers: [{ tier: { type: "output", size: 100_000 } }],
        }),
        "google:model-test",
      ),
    ).toThrow("unsupported cost tier");

    expect(() =>
      modelRateFromModelsDev(
        model({
          input: 1,
          output: 2,
          tiers: [
            {
              tier: {
                type: "context",
                size: 100_000,
                inclusive: false,
              },
              input: 2,
              output: 4,
            },
          ],
        }),
        "google:model-test",
      ),
    ).toThrow("unsupported context-tier fields: inclusive");

    expect(() =>
      modelRateFromModelsDev(
        model({
          input: 1,
          output: 2,
          tiers: [
            { tier: { type: "context", size: 100_000 } },
            { tier: { type: "context", size: 200_000 } },
          ],
        }),
        "google:model-test",
      ),
    ).toThrow("exactly one context-price tier");
  });
});

describe("model rate module rendering", () => {
  test("is stable and preserves source provenance", () => {
    const rows = [
      {
        modelId: "gpt-test",
        rate: {
          kind: "flat",
          inputPerMTok: 875,
          outputPerMTok: 3125,
        },
        source: "openai:gpt-test",
        sourceReason: null,
        sourceUrl: null,
      },
      {
        modelId: "claude-alias",
        rate: {
          kind: "flat",
          inputPerMTok: 25_000,
          outputPerMTok: 100_000,
        },
        source: "anthropic:claude-source",
        sourceReason: "2026-09-03: provider alias",
        sourceUrl: "https://example.com/provider-alias",
      },
    ] satisfies GeneratedModelRateRow[];

    const rendered = renderModelRatesModule(rows);

    expect(rendered).toBe(renderModelRatesModule(rows));
    expect(rendered).toContain("// models.dev: openai:gpt-test");
    expect(rendered).toContain("// models.dev: anthropic:claude-source");
    expect(rendered).toContain(
      "// reviewed source mapping: 2026-09-03: provider alias",
    );
    expect(rendered).toContain(
      "// reviewed source: https://example.com/provider-alias",
    );
    expect(rendered).toContain("inputPerMTok: 875,");
    expect(rendered).toContain("outputPerMTok: 3125,");
    expect(rendered.indexOf('"gpt-test"')).toBeLessThan(
      rendered.indexOf('"claude-alias"'),
    );
  });
});
