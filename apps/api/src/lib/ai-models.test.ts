import { describe, expect, mock, test } from "bun:test";

// Stub env before importing ai-models.ts, which reads env at
// module level for MODEL_OVERRIDES.
void mock.module("@/api/env", () => ({
  env: {
    AI_MODEL_FAST: undefined,
    AI_MODEL_CHAT: undefined,
    AI_MODEL_REASONING: undefined,
    AI_MODEL_PDF: undefined,
  },
}));

const { REGIONAL_PROVIDERS, supportsRegion } =
  await import("@/api/lib/ai-models");

type AIProvider =
  | "google"
  | "openrouter"
  | "openai"
  | "anthropic"
  | "openai_compatible";

describe("supportsRegion", () => {
  test("google supports regional routing", () => {
    expect(supportsRegion("google")).toBe(true);
  });

  test("non-google providers do not support regional routing", () => {
    const nonRegional: AIProvider[] = [
      "openrouter",
      "openai",
      "anthropic",
      "openai_compatible",
    ];

    for (const provider of nonRegional) {
      expect(supportsRegion(provider)).toBe(false);
    }
  });
});

describe("REGIONAL_PROVIDERS", () => {
  test("contains exactly one provider (google)", () => {
    expect(REGIONAL_PROVIDERS.size).toBe(1);
    expect(REGIONAL_PROVIDERS.has("google")).toBe(true);
  });
});
