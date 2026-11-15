import { EventType } from "@tanstack/ai";
import { expect, test } from "bun:test";

import { createTestState } from "@stll/test-state";

import { env } from "@/api/env";
import type { CachingDecision } from "@/api/lib/ai-config";
import { streamChatChunks } from "@/api/lib/chat/tanstack-chat-runtime";
import { mergeGenerationOptions } from "@/api/lib/tanstack-ai-generate";
import {
  createTanStackTextAdapterFactory,
  tanStackModelOptionsForTask,
} from "@/api/lib/tanstack-ai-models";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";

const fetchState = createTestFetch();
const testState = createTestState({ file: import.meta.path, config: env });
const scopeKey = "organization:contract-probe";
const hashedScope =
  "106a444562569784437b331c30f0edcfa70367d5e744cdba050d7234d6ee197c";

for (const modelId of ["gpt-6-luna", "gpt-5.6-luna", "gpt-5.5"]) {
  for (const policy of ["scoped", "unscoped", "off"] as const) {
    test(`OpenAI ${modelId} preserves stella's ${policy} cache policy on the actual request`, async () => {
      testState.setConfig("USE_MOCK_AI", false);
      const requests: unknown[] = [];
      fetchState.set(
        Object.assign(
          async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            if (typeof init?.body !== "string") {
              throw new TypeError("Expected the SDK's serialized request body");
            }
            const body: unknown = JSON.parse(init.body);
            requests.push(body);
            const event = {
              type: "response.completed",
              sequence_number: 0,
              response: {
                id: "resp_cache_policy",
                object: "response",
                created_at: 0,
                status: "completed",
                model: modelId,
                output: [],
                usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
              },
            };
            return new Response(
              `event: response.completed\ndata: ${JSON.stringify(event)}\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            );
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      );
      const adapter = createTanStackTextAdapterFactory({
        provider: "openai",
        apiKey: "cache-policy-fixture-key",
        dataClass: "customer",
      })(modelId);
      const caching: CachingDecision =
        policy === "off"
          ? { enabled: false, reason: "org-disabled" }
          : {
              enabled: true,
              ttl: "5m",
              scopeKey: policy === "scoped" ? scopeKey : null,
            };
      const modelOptions = mergeGenerationOptions({
        caching,
        model: {
          adapter,
          keySource: "byok",
          provider: "openai",
          modelId,
          modelOptions: tanStackModelOptionsForTask({
            provider: "openai",
            modelId,
            task: "chat",
            organizationId: null,
          }),
        },
        maxOutputTokens: undefined,
        serviceTier: "standard",
        temperature: undefined,
      });
      const events = [];
      for await (const chunk of streamChatChunks({
        adapter,
        modelOptions,
        messages: [{ role: "user", content: "Check the cache policy." }],
        threadId: "must-not-become-the-cache-key",
        debug: false,
      })) {
        events.push(chunk.type);
      }
      expect(events).not.toContain(EventType.RUN_ERROR);
      expect(events).toContain(EventType.RUN_FINISHED);
      expect(requests).toHaveLength(1);
      const [body] = requests;
      if (modelId === "gpt-5.5") {
        expect(body).not.toHaveProperty("prompt_cache_options");
      } else {
        expect(body).toHaveProperty("prompt_cache_options", {
          mode: policy === "off" ? "explicit" : "implicit",
        });
      }
      if (policy === "scoped") {
        expect(body).toHaveProperty("prompt_cache_key", hashedScope);
      } else {
        expect(body).not.toHaveProperty("prompt_cache_key");
      }
      expect(body).not.toHaveProperty("prompt_cache_retention");
      expect(JSON.stringify(body)).not.toContain("prompt_cache_breakpoint");
      expect(JSON.stringify(body)).not.toContain(scopeKey);
      expect(JSON.stringify(body)).not.toContain(
        "must-not-become-the-cache-key",
      );
    });
  }
}
