import { convertSchemaToJsonSchema } from "@tanstack/ai";
import type { Tool } from "@tanstack/ai";
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
import { createTanStackTextAdapterFactory } from "@/api/lib/tanstack-ai-models";

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

const CAPTURE_RESPONSE_MESSAGE = "Offline provider request capture complete.";

const consumeProviderStream = async (
  stream: AsyncIterable<unknown>,
): Promise<void> => {
  const streamError = await (async () => {
    for await (const _chunk of stream) {
      // Provider errors are expected after the transport captures the request.
    }
  })().then(
    () => null,
    (error: unknown) => error,
  );
  if (streamError === null) {
    return;
  }
  if (!(streamError instanceof Error)) {
    return panic("Provider adapter rejected with a non-Error value.");
  }
  if (streamError.message.includes(CAPTURE_RESPONSE_MESSAGE)) {
    return;
  }
  throw streamError;
};

type CapturedHttpRequest = {
  body: unknown;
  pathname: string;
};

const installRequestCaptureTransport = () => {
  const originalFetch = globalThis.fetch;
  const requests: CapturedHttpRequest[] = [];
  let blockedAttempts = 0;
  const blockNativeNetwork = (): never => {
    blockedAttempts += 1;
    throw new TypeError("Provider matrix network access is forbidden.");
  };
  const nativeSpies = [
    spyOn(nodeHttp, "request").mockImplementation(blockNativeNetwork),
    spyOn(nodeHttp, "get").mockImplementation(blockNativeNetwork),
    spyOn(nodeHttps, "request").mockImplementation(blockNativeNetwork),
    spyOn(nodeHttps, "get").mockImplementation(blockNativeNetwork),
    spyOn(nodeHttp2, "connect").mockImplementation(blockNativeNetwork),
  ];
  const captureFetch = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
    requests.push({
      body: await request.clone().json(),
      pathname: new URL(request.url).pathname,
    });
    return new Response(
      JSON.stringify({
        error: {
          message: CAPTURE_RESPONSE_MESSAGE,
          type: "invalid_request_error",
        },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  };
  globalThis.fetch = Object.assign(captureFetch, {
    preconnect: () => {
      blockedAttempts += 1;
      throw new TypeError("Provider matrix network access is forbidden.");
    },
  });
  return {
    blockedAttemptCount: () => blockedAttempts,
    requests,
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
  decision: null,
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

const modelIdFromPath = ({
  description,
  pathname,
  prefix,
  suffix,
}: {
  description: string;
  pathname: string;
  prefix: string;
  suffix: string;
}): string => {
  const decodedPath = decodeURIComponent(pathname);
  const start = decodedPath.lastIndexOf(prefix);
  if (start === -1 || !decodedPath.endsWith(suffix)) {
    return panic(`Expected ${description} model id in request path.`);
  }
  return decodedPath.slice(start + prefix.length, -suffix.length);
};

const captureProviderRequest = async (
  options: CaptureProviderRequestOptions,
  transport: ReturnType<typeof installRequestCaptureTransport>,
): Promise<CapturedProviderRequest> => {
  const requestIndex = transport.requests.length;
  const createAdapter = createTanStackTextAdapterFactory({
    apiKey: "test-key",
    provider: options.provider,
  });
  const adapter = createAdapter(options.modelId);
  await consumeProviderStream(
    adapter.chatStream(commonProviderOptions(adapter.model, options.tools)),
  );
  if (transport.requests.length !== requestIndex + 1) {
    return panic(
      `Expected one ${options.provider} request, received ${String(transport.requests.length - requestIndex)}.`,
    );
  }
  const captured =
    transport.requests.at(requestIndex) ??
    panic(`Expected a captured ${options.provider} request.`);
  const request = requireRecord(
    captured.body,
    `${options.provider} HTTP request body`,
  );

  switch (options.provider) {
    case "openai": {
      return {
        request,
        requestTools: requireArray(request["tools"], "OpenAI request tools"),
        wireModelId: request["model"],
      };
    }
    case "google": {
      const groups = requireArray(request["tools"], "Gemini request tools");
      return {
        request,
        requestTools: groups.flatMap((group) => {
          const toolGroup = requireRecord(group, "Gemini tool group");
          return Array.isArray(toolGroup["functionDeclarations"])
            ? toolGroup["functionDeclarations"]
            : [toolGroup];
        }),
        wireModelId: modelIdFromPath({
          description: "Gemini",
          pathname: captured.pathname,
          prefix: "/models/",
          suffix: ":streamGenerateContent",
        }),
      };
    }
    case "anthropic": {
      return {
        request,
        requestTools: requireArray(request["tools"], "Anthropic request tools"),
        wireModelId: request["model"],
      };
    }
    case "bedrock": {
      const toolConfig = requireRecord(
        request["toolConfig"],
        "Bedrock tool config",
      );
      return {
        request,
        requestTools: requireArray(
          toolConfig["tools"],
          "Bedrock request tools",
        ),
        wireModelId: modelIdFromPath({
          description: "Bedrock",
          pathname: captured.pathname,
          prefix: "/model/",
          suffix: "/converse-stream",
        }),
      };
    }
    case "openrouter": {
      return {
        request,
        requestTools: requireArray(
          request["tools"],
          "OpenRouter request tools",
        ),
        wireModelId: request["model"],
      };
    }
    case "mistral": {
      return {
        request,
        requestTools: requireArray(request["tools"], "Mistral request tools"),
        wireModelId: request["model"],
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
    const transport = installRequestCaptureTransport();
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
              await captureProviderRequest(
                {
                  ...selection,
                  tools,
                },
                transport,
              );

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
      expect(transport.blockedAttemptCount()).toBe(0);
    } finally {
      transport.restore();
    }
  }, 180_000);
});
