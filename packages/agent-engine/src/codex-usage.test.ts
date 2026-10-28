import { translateThreadEvents } from "@tanstack/ai-codex";
import type { CodexThreadEvent, CodexUsage } from "@tanstack/ai-codex";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

const translateUsage = async (usage: CodexUsage) => {
  const events = async function* (): AsyncGenerator<CodexThreadEvent> {
    yield { type: "thread.started", thread_id: "codex-session" };
    yield { type: "turn.started" };
    yield {
      type: "item.completed",
      item: { id: "answer", type: "agent_message", text: "Done" },
    };
    yield { type: "turn.completed", usage };
  };
  const chunks = await Array.fromAsync(
    translateThreadEvents(events(), {
      model: "gpt-5",
      runId: "usage-run",
      threadId: "usage-thread",
      genId: () => Bun.randomUUIDv7(),
    }),
  );
  const completed = chunks.find(({ type }) => type === "RUN_FINISHED");
  expect(completed).toBeDefined();
  return completed?.usage;
};

test("Codex usage preserves independent cache-read and cache-write counters", async () => {
  await assertProperty(
    "agent-engine.codex-usage.cache-counters",
    fc.asyncProperty(
      fc.record(
        {
          input_tokens: fc.nat({ max: 1_000_000 }),
          output_tokens: fc.nat({ max: 1_000_000 }),
          cached_input_tokens: fc.nat({ max: 1000 }),
          cache_write_input_tokens: fc.nat({ max: 1000 }),
        },
        { requiredKeys: ["input_tokens", "output_tokens"] },
      ),
      async (usage) => {
        const translated = await translateUsage(usage);
        expect(translated).toMatchObject({
          promptTokens: usage.input_tokens,
          completionTokens: usage.output_tokens,
          totalTokens: usage.input_tokens + usage.output_tokens,
        });
        expect(translated?.promptTokensDetails?.cachedTokens).toBe(
          usage.cached_input_tokens,
        );
        expect(translated?.promptTokensDetails?.cacheWriteTokens).toBe(
          usage.cache_write_input_tokens,
        );
      },
    ),
  );
});

test("Codex reports zero cache writes without inventing an absent cache-read counter", async () => {
  expect(
    await translateUsage({
      input_tokens: 12,
      output_tokens: 3,
      cache_write_input_tokens: 0,
    }),
  ).toMatchObject({
    promptTokensDetails: { cacheWriteTokens: 0 },
  });
  expect(
    (await translateUsage({ input_tokens: 12, output_tokens: 3 }))
      ?.promptTokensDetails,
  ).toBeUndefined();
});
