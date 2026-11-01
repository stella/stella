import type { OwnershipEntry } from "../ownership-types.ts";
import { PROVIDER_CLIENT_MODULES } from "../provider-client-modules.ts";

// What builds a provider client: each SDK's client class or default export,
// and each adapter package's adapter classes and factories. Types and option
// helpers stay open to every module.
const PROVIDER_CLIENT_BUILDERS = [
  "default",
  // Provider SDK clients.
  "OpenAI",
  "AzureOpenAI",
  "Anthropic",
  "AnthropicBedrock",
  "AnthropicVertex",
  "GoogleGenAI",
  "GoogleGenerativeAI",
  "Mistral",
  "OpenRouter",
  "BedrockRuntimeClient",
  "HfInference",
  "InferenceClient",
  "createAmazonBedrock",
  "createAnthropic",
  "createAzure",
  "createGoogleGenerativeAI",
  "createMistral",
  "createOpenAI",
  "createOpenAICompatible",
  // TanStack adapters, and the adapter subclass the model factory builds.
  "AnthropicTextAdapter",
  "anthropicText",
  "createAnthropicChat",
  "createAnthropicChatWithClient",
  "createAnthropicSummarize",
  "BedrockConverseTextAdapter",
  "BedrockResponsesTextAdapter",
  "BedrockTextAdapter",
  "bedrockText",
  "createBedrockChat",
  "createBedrockConverse",
  "createBedrockResponsesText",
  "createBedrockText",
  "GeminiTextAdapter",
  "geminiText",
  "createGeminiChat",
  "createGeminiSummarize",
  "MistralTextAdapter",
  "mistralText",
  "createMistralText",
  "OpenAIChatCompletionsTextAdapter",
  "OpenAIBaseResponsesTextAdapter",
  "OpenAIBaseChatCompletionsTextAdapter",
  "OpenAITextAdapter",
  "openaiText",
  "createOpenaiChat",
  "createOpenaiChatCompletions",
  "createOpenaiSummarize",
  "OpenRouterResponsesTextAdapter",
  "OpenRouterTextAdapter",
  "openRouterResponsesText",
  "openRouterText",
  "createOpenRouterResponsesText",
  "createOpenRouterSummarize",
  "createOpenRouterText",
  "StellaOpenRouterTextAdapter",
  "createManagedOpenRouterText",
  "createStellaOpenRouterText",
] as const;

export default {
  id: "provider-client-construction",
  capability: "Building a client that sends requests to an AI model provider",
  owner: [
    "apps/api/src/lib/tanstack-ai-models.ts",
    "apps/api/src/lib/stella-openrouter-text-adapter.ts",
  ],
  summary:
    "A model request is sent once by its provider client and retried only " +
    "by the generation layer (`apps/api/src/lib/errors/" +
    "provider-retry-policy.ts`), so every send passes the checks that layer " +
    "makes before a dispatch. The owners build every provider client with " +
    "its own retries and continuation off, and " +
    "`apps/api/src/lib/tanstack-ai-models.retries.test.ts` holds each " +
    "provider to one request per attempt. `no-restricted-imports` bans the " +
    "static imports elsewhere (`scripts/provider-client-modules.ts`); this " +
    "row also reaches a dynamic import, which that rule does not read.",
  enforcement: {
    kind: "import",
    specifiers: PROVIDER_CLIENT_MODULES,
    names: PROVIDER_CLIENT_BUILDERS,
    allowed: [
      {
        path: "apps/api/src/lib/stella-openrouter-text-adapter.type-test.ts",
        reason:
          "Type-level test of the managed adapter's request options; it reads a factory's parameter type and builds no client.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
