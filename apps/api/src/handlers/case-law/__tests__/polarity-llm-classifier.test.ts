import { describe, expect, test } from "bun:test";

process.env["EMAIL_PROVIDER"] ??= "smtp";
process.env["GOTENBERG_PASSWORD"] ??= "gotenberg";
process.env["GOTENBERG_URL"] ??= "http://localhost:3003";
process.env["GOTENBERG_USERNAME"] ??= "gotenberg";
process.env["AI_PROVIDER"] = "openai";
process.env["OPENAI_API_KEY"] ??= "test-openai-instance-key";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["SMTP_HOST"] ??= "localhost";
process.env["SMTP_PORT"] ??= "1025";

describe("polarity LLM classifier", () => {
  test("keeps prompt caching scoped per language", async () => {
    const { resolvePolarityClassifierCaching } =
      await import("@/api/handlers/case-law/polarity/llm-classifier");

    expect(resolvePolarityClassifierCaching("cs")).toEqual({
      enabled: true,
      ttl: "5m",
      scopeKey: "polarity:cs",
    });
  });
});
