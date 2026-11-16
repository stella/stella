import type { AnyTextAdapter } from "@tanstack/ai";

import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const UNREACHABLE = "The provider must not be reached";

/**
 * A model for the real generation path whose provider records every request
 * that reaches it and then fails. A test that expects a refusal before any
 * request asserts `requests` stays empty, so it fails the moment the
 * generation sends one it should have stopped.
 */
export const createUnreachableTextModel = () => {
  const requests: ("chatStream" | "structuredOutput")[] = [];
  const adapter: AnyTextAdapter = {
    kind: "text",
    name: "unreachable",
    model: "unreachable-model",
    "~types": {
      providerOptions: {},
      inputModalities: ["text"],
      messageMetadataByModality: {},
      toolCapabilities: [],
      toolCallMetadata: {},
      systemPromptMetadata: undefined,
    },
    chatStream: () => {
      requests.push("chatStream");
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => await Promise.reject(new Error(UNREACHABLE)),
        }),
      };
    },
    structuredOutput: async () => {
      requests.push("structuredOutput");
      return await Promise.reject(new Error(UNREACHABLE));
    },
  };
  const model = asTestRaw<ResolvedTanStackTextModel>({
    adapter,
    keySource: "instance",
    modelId: "unreachable-model",
    modelOptions: {},
    provider: "openai",
  });
  return { requests, resolveTextModel: () => model };
};
