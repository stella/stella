import type { LanguageModelV3Usage } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import { isMockAI } from "@/api/consts";
import { registerMockModelFactory } from "@/api/lib/ai-models";
import { generateBatchMock } from "@/api/lib/workflow/generate-batch-mock";
import { registerBatchGenerator } from "@/api/lib/workflow/generate-batch-provider";

// Dev/test-only preload: wired via the api `dev` script's `--preload`, never
// imported from `src/index.ts`. Registering the faker-backed mock generator here
// (rather than referencing it from the production handlers) keeps
// `generate-batch-mock` and `@faker-js/faker` out of the production build — both
// the compiled binary and the knip `--production` graph.

const MOCK_REPLY =
  "Mock assistant reply: streaming is stubbed because USE_MOCK_AI is set.";

const mockUsage: LanguageModelV3Usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

if (isMockAI()) {
  registerBatchGenerator(generateBatchMock);
  registerMockModelFactory(
    (modelId) =>
      new MockLanguageModelV3({
        modelId,
        doGenerate: {
          content: [{ type: "text", text: MOCK_REPLY }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: mockUsage,
          warnings: [],
        },
        doStream: {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "mock-text" },
              { type: "text-delta", id: "mock-text", delta: MOCK_REPLY },
              { type: "text-end", id: "mock-text" },
              {
                type: "finish" as const,
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage: mockUsage,
              },
            ],
          }),
        },
      }),
  );
}
