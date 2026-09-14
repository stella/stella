import {
  convertSchemaToJsonSchema,
  createModel,
  extendAdapter,
} from "@tanstack/ai";
import type { Tool } from "@tanstack/ai";
import { createAnthropicChat } from "@tanstack/ai-anthropic";
import { BedrockConverseTextAdapter } from "@tanstack/ai-bedrock";
import { createGeminiChat } from "@tanstack/ai-gemini";
import { createMistralText } from "@tanstack/ai-mistral";
import { createOpenaiChat } from "@tanstack/ai-openai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { panic } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";
import * as nodeHttp from "node:http";
import * as nodeHttp2 from "node:http2";
import * as nodeHttps from "node:https";

import {
  BYOK_MODEL_OPTIONS,
  DEFAULT_MODELS,
  isBYOKModelRoleSupported,
} from "@stll/ai-catalog";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import { createStellaOpenRouterText } from "@/api/lib/stella-openrouter-text-adapter";

import {
  buildCanaryChatToolsets,
  chatToolsetScenarios,
  projectCanaryChatToolset,
} from "./ai-provider-canary-chat-toolsets";
import {
  CANARY_PROVIDERS,
  type CanaryProvider,
} from "./ai-provider-canary-config";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireRecord = (
  value: unknown,
  description: string,
): Record<string, unknown> =>
  isRecord(value) ? value : panic(`Expected ${description} to be an object.`);

const requireArray = (value: unknown, description: string): unknown[] =>
  Array.isArray(value)
    ? value
    : panic(`Expected ${description} to be an array.`);

const emptyProviderStream = async function* () {
  // The adapter contract only needs to map and issue the SDK request.
};

const consumeProviderStream = async (
  stream: AsyncIterable<unknown>,
): Promise<void> => {
  for await (const _chunk of stream) {
    // The fake provider streams are empty.
  }
};

const installOfflineNetworkGuard = () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  const blockNativeNetwork = (): never => {
    attempts += 1;
    throw new TypeError("Provider matrix network access is forbidden.");
  };
  const nativeSpies = [
    spyOn(nodeHttp, "request").mockImplementation(blockNativeNetwork),
    spyOn(nodeHttp, "get").mockImplementation(blockNativeNetwork),
    spyOn(nodeHttps, "request").mockImplementation(blockNativeNetwork),
    spyOn(nodeHttps, "get").mockImplementation(blockNativeNetwork),
    spyOn(nodeHttp2, "connect").mockImplementation(blockNativeNetwork),
  ];
  const blockedFetch = async (
    ..._args: Parameters<typeof globalThis.fetch>
  ) => {
    attempts += 1;
    throw new TypeError("Provider matrix network access is forbidden.");
  };
  globalThis.fetch = Object.assign(blockedFetch, {
    preconnect: () => {
      attempts += 1;
      throw new TypeError("Provider matrix network access is forbidden.");
    },
  });
  return {
    attemptCount: () => attempts,
    restore: () => {
      globalThis.fetch = originalFetch;
      for (const spy of nativeSpies) {
        spy.mockRestore();
      }
    },
  };
};

const chatModelIds = <TProvider extends CanaryProvider>(
  provider: TProvider,
): (typeof BYOK_MODEL_OPTIONS)[TProvider][number][] =>
  BYOK_MODEL_OPTIONS[provider].filter((modelId) =>
    isBYOKModelRoleSupported({ modelId, provider, role: "chat" }),
  );

type ChatModelSelection = {
  [TProvider in CanaryProvider]: {
    modelId: (typeof BYOK_MODEL_OPTIONS)[TProvider][number];
    provider: TProvider;
  };
}[CanaryProvider];

const chatModelSelections = (
  provider: CanaryProvider,
): ChatModelSelection[] => {
  switch (provider) {
    case "google":
      return chatModelIds(provider).map((modelId) => ({ modelId, provider }));
    case "openrouter":
      return chatModelIds(provider).map((modelId) => ({ modelId, provider }));
    case "openai":
      return chatModelIds(provider).map((modelId) => ({ modelId, provider }));
    case "anthropic":
      return chatModelIds(provider).map((modelId) => ({ modelId, provider }));
    case "bedrock":
      return chatModelIds(provider).map((modelId) => ({ modelId, provider }));
    case "mistral":
      return chatModelIds(provider).map((modelId) => ({ modelId, provider }));
    default: {
      provider satisfies never;
      return panic(`Unhandled provider: ${String(provider)}`);
    }
  }
};

const canaryConfig = (provider: CanaryProvider): OrgAIConfig => ({
  providers: [{ apiKey: "test-key", provider }],
  overrideModels: {
    fast: { modelId: DEFAULT_MODELS[provider].fast, provider },
    chat: { modelId: DEFAULT_MODELS[provider].chat, provider },
    reasoning: { modelId: DEFAULT_MODELS[provider].reasoning, provider },
    pdf: { modelId: DEFAULT_MODELS[provider].pdf, provider },
  },
});

const serializeTools = (
  tools: ReturnType<typeof projectCanaryChatToolset>,
): Tool[] =>
  tools.map((tool) => ({
    description: tool.description,
    inputSchema:
      convertSchemaToJsonSchema(tool.inputSchema) ??
      panic(`Tool ${tool.name} did not serialize.`),
    name: tool.name,
  }));

const commonProviderOptions = (model: string, tools: Tool[]) => ({
  logger: resolveDebugOption(false),
  messages: [{ role: "user" as const, content: "Contract probe." }],
  model,
  tools,
});

type CapturedProviderRequest = {
  request: Record<string, unknown>;
  requestTools: unknown[];
  wireModelId: unknown;
};

type CaptureProviderRequestOptions = ChatModelSelection & { tools: Tool[] };

const captureProviderRequest = async (
  options: CaptureProviderRequestOptions,
): Promise<CapturedProviderRequest> => {
  switch (options.provider) {
    case "openai": {
      const createAdapter = extendAdapter(createOpenaiChat, [
        createModel(options.modelId, {
          features: ["structured_outputs"] as const,
          input: ["text", "image", "document"] as const,
        }),
      ]);
      const adapter = createAdapter(options.modelId, "test-key");
      let request: unknown;
      Reflect.set(adapter, "client", {
        responses: {
          create: (payload: unknown) => {
            request = payload;
            return emptyProviderStream();
          },
        },
      });
      await consumeProviderStream(
        adapter.chatStream(commonProviderOptions(adapter.model, options.tools)),
      );
      const record = requireRecord(request, "OpenAI request");
      return {
        request: record,
        requestTools: requireArray(record["tools"], "OpenAI request tools"),
        wireModelId: record["model"],
      };
    }
    case "google": {
      const createAdapter = extendAdapter(createGeminiChat, [
        createModel(options.modelId, {
          features: ["structured_outputs"] as const,
          input: ["text", "image", "document"] as const,
        }),
      ]);
      const adapter = createAdapter(options.modelId, "test-key");
      let request: unknown;
      Reflect.set(adapter, "client", {
        models: {
          generateContentStream: (payload: unknown) => {
            request = payload;
            return emptyProviderStream();
          },
        },
      });
      await consumeProviderStream(
        adapter.chatStream(commonProviderOptions(adapter.model, options.tools)),
      );
      const record = requireRecord(request, "Gemini request");
      const config = requireRecord(record["config"], "Gemini request config");
      const groups = requireArray(config["tools"], "Gemini request tools");
      return {
        request: record,
        requestTools: groups.flatMap((group) => {
          const toolGroup = requireRecord(group, "Gemini tool group");
          return Array.isArray(toolGroup["functionDeclarations"])
            ? toolGroup["functionDeclarations"]
            : [toolGroup];
        }),
        wireModelId: record["model"],
      };
    }
    case "anthropic": {
      const createAdapter = extendAdapter(createAnthropicChat, [
        createModel(options.modelId, {
          features: ["structured_outputs"] as const,
          input: ["text", "image", "document"] as const,
        }),
      ]);
      const adapter = createAdapter(options.modelId, "test-key");
      let request: unknown;
      Reflect.set(adapter, "client", {
        beta: {
          messages: {
            create: (payload: unknown) => {
              request = payload;
              return emptyProviderStream();
            },
          },
        },
      });
      await consumeProviderStream(
        adapter.chatStream(commonProviderOptions(adapter.model, options.tools)),
      );
      const record = requireRecord(request, "Anthropic request");
      return {
        request: record,
        requestTools: requireArray(record["tools"], "Anthropic request tools"),
        wireModelId: record["model"],
      };
    }
    case "bedrock": {
      let request: unknown;
      class CapturingBedrockTextAdapter extends BedrockConverseTextAdapter<never> {
        protected override async sendStream(input: unknown) {
          request = input;
          return await Promise.resolve(emptyProviderStream());
        }
      }
      const createAdapter = extendAdapter(
        (model: never) =>
          new CapturingBedrockTextAdapter({ apiKey: "test-key" }, model),
        [
          createModel(options.modelId, {
            features: ["structured_outputs"] as const,
            input: ["text", "image", "document"] as const,
          }),
        ],
      );
      const adapter = createAdapter(options.modelId);
      await consumeProviderStream(
        adapter.chatStream(commonProviderOptions(adapter.model, options.tools)),
      );
      const record = requireRecord(request, "Bedrock request");
      const toolConfig = requireRecord(
        record["toolConfig"],
        "Bedrock tool config",
      );
      return {
        request: record,
        requestTools: requireArray(
          toolConfig["tools"],
          "Bedrock request tools",
        ),
        wireModelId: record["modelId"],
      };
    }
    case "openrouter": {
      const createAdapter = extendAdapter(createStellaOpenRouterText, [
        createModel(options.modelId, {
          features: ["structured_outputs"] as const,
          input: ["text", "image", "document"] as const,
        }),
      ]);
      const adapter = createAdapter(options.modelId, "test-key");
      let request: unknown;
      Reflect.set(adapter, "orClient", {
        chat: {
          send: (payload: unknown) => {
            request = payload;
            return emptyProviderStream();
          },
        },
      });
      await consumeProviderStream(
        adapter.chatStream(commonProviderOptions(adapter.model, options.tools)),
      );
      const record = requireRecord(request, "OpenRouter SDK request");
      const chatRequest = requireRecord(
        record["chatRequest"],
        "OpenRouter chat request",
      );
      return {
        request: record,
        requestTools: requireArray(
          chatRequest["tools"],
          "OpenRouter request tools",
        ),
        wireModelId: chatRequest["model"],
      };
    }
    case "mistral": {
      const createAdapter = extendAdapter(createMistralText, [
        createModel(options.modelId, {
          features: ["structured_outputs"] as const,
          input: ["text", "image"] as const,
        }),
      ]);
      const adapter = createAdapter(options.modelId, "test-key");
      let request: unknown;
      Reflect.set(adapter, "fetchRawMistralStream", (payload: unknown) => {
        request = payload;
        return emptyProviderStream();
      });
      await consumeProviderStream(
        adapter.chatStream(commonProviderOptions(adapter.model, options.tools)),
      );
      const record = requireRecord(request, "Mistral request");
      return {
        request: record,
        requestTools: requireArray(record["tools"], "Mistral request tools"),
        wireModelId: record["model"],
      };
    }
    default: {
      options satisfies never;
      return panic("Unhandled provider.");
    }
  }
};

const emptyEnumPaths = (value: unknown, path = "request"): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      emptyEnumPaths(item, `${path}[${String(index)}]`),
    );
  }
  if (!isRecord(value)) {
    return [];
  }
  const paths =
    Array.isArray(value["enum"]) && value["enum"].length === 0 ? [path] : [];
  for (const [key, child] of Object.entries(value)) {
    paths.push(...emptyEnumPaths(child, `${path}.${key}`));
  }
  return paths;
};

const emptyStringEnumPaths = (value: unknown, path = "request"): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      emptyStringEnumPaths(item, `${path}[${String(index)}]`),
    );
  }
  if (!isRecord(value)) {
    return [];
  }
  const paths =
    Array.isArray(value["enum"]) && value["enum"].includes("") ? [path] : [];
  for (const [key, child] of Object.entries(value)) {
    paths.push(...emptyStringEnumPaths(child, `${path}.${key}`));
  }
  return paths;
};

describe("AI provider production chat tool matrix", () => {
  test("maps every advertised chat model and DOCX registry through its real SDK adapter with accepted enums", async () => {
    const networkGuard = installOfflineNetworkGuard();
    try {
      expect(chatToolsetScenarios().map(({ id }) => id)).toEqual([
        "manual:file-overlay",
        "manual:template-studio",
        "auto:file-overlay",
      ]);

      let cells = 0;
      for (const provider of CANARY_PROVIDERS) {
        const toolsets = buildCanaryChatToolsets(canaryConfig(provider));
        for (const selection of chatModelSelections(provider)) {
          const { modelId } = selection;
          for (const toolset of toolsets) {
            const tools = serializeTools(
              projectCanaryChatToolset({ provider, toolset }),
            );
            const { request, requestTools, wireModelId } =
              await captureProviderRequest({
                ...selection,
                tools,
              });

            expect(
              requestTools,
              `${provider}/${modelId}/${toolset.id}`,
            ).toHaveLength(tools.length);
            expect(wireModelId, `${provider}/${modelId}/${toolset.id}`).toBe(
              modelId,
            );
            expect(
              emptyEnumPaths(request),
              `${provider}/${modelId}/${toolset.id}`,
            ).toEqual([]);
            if (provider === "google" || provider === "openrouter") {
              expect(
                emptyStringEnumPaths(request),
                `${provider}/${modelId}/${toolset.id}`,
              ).toEqual([]);
            }
            cells += 1;
          }
        }
      }

      const advertisedChatModels = CANARY_PROVIDERS.reduce(
        (count, provider) => count + chatModelSelections(provider).length,
        0,
      );
      expect(cells).toBe(advertisedChatModels * chatToolsetScenarios().length);
      expect(networkGuard.attemptCount()).toBe(0);
    } finally {
      networkGuard.restore();
    }
  }, 180_000);
});
