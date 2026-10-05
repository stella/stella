import { Result } from "better-result";

import {
  MODEL_BENCHMARK_LICENCE,
  MODEL_BENCHMARK_NAME,
  MODEL_BENCHMARK_PUBLISH_DATE,
  MODEL_BENCHMARK_SOURCE_URL,
  TYPICAL_CALL_INPUT_TOKENS,
  TYPICAL_CALL_OUTPUT_TOKENS,
} from "@stll/ai-catalog/benchmarks";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  getChatModelBenchmarkOptions,
  getConfiguredChatModelOptions,
  getDefaultChatModelValue,
} from "@/api/lib/chat-model-selection";

const config = {
  // Any org member picking a chat model needs to see the catalog; the
  // response carries only model identifiers, never key material, so this
  // does not require admin scope (mirrors read-ai-availability.ts).
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
} satisfies HandlerConfig;

const getModelOptions = createSafeRootHandler(
  config,
  // oxlint-disable-next-line require-yield, typescript/require-await -- safe handlers must remain async generators for Result.gen error capture.
  async function* ({ orgAIConfig, session }) {
    return Result.ok({
      options: getConfiguredChatModelOptions(orgAIConfig),
      defaultValue: getDefaultChatModelValue({
        orgAIConfig,
        organizationId: session.activeOrganizationId,
      }),
      benchmarkOptions: getChatModelBenchmarkOptions(orgAIConfig),
      benchmarkMetadata: {
        benchmarkName: MODEL_BENCHMARK_NAME,
        licence: MODEL_BENCHMARK_LICENCE,
        publishDate: MODEL_BENCHMARK_PUBLISH_DATE,
        sourceUrl: MODEL_BENCHMARK_SOURCE_URL,
        typicalCallInputTokens: TYPICAL_CALL_INPUT_TOKENS,
        typicalCallOutputTokens: TYPICAL_CALL_OUTPUT_TOKENS,
      },
    });
  },
);

export default getModelOptions;
