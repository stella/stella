import { describe, expect, test } from "bun:test";

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
