import type { OfferedBYOKModelId, TanStackAIProvider } from "./index";
import type { RETAINED_MODELS_DEV_RATE_ENTRIES } from "./model-rate-policy";

export const REASONING_REPLAY_FORMATS = [
  "openai-encrypted-content",
  "openai-item-id",
  "anthropic-thinking-signature",
  "anthropic-redacted-thinking",
  "google-thought-signature",
  "none",
] as const;

export type ReasoningReplayFormat = (typeof REASONING_REPLAY_FORMATS)[number];
export type ReasoningProvenance = {
  provider: TanStackAIProvider;
  model: string;
  format: ReasoningReplayFormat;
};

export type ModelReasoningCapabilities = {
  support: "supported" | "unsupported";
  emittedFormats: readonly ReasoningReplayFormat[];
  openAIIncludeEncryptedContent: boolean;
  openAIStore: false | null;
  anthropicThinking: "adaptive" | "budget" | "none";
  replayCompatibility: readonly ReasoningProvenance[];
};

// Replay is deliberately limited to the producing provider and model. A
// cross-model allowance needs recorded provider evidence before it is added.
// OpenRouter, Bedrock and Mistral currently expose reasoning text without a
// replayable signature through their installed adapters.
// Native Anthropic currently emits signed thinking only; redacted blocks are
// not exposed by the installed adapter, so they are not admitted for replay.
export const MODEL_REASONING_CAPABILITIES = {
  "gemini-3.8-flash": {
    support: "supported",
    emittedFormats: ["google-thought-signature"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [
      {
        provider: "google",
        model: "gemini-3.8-flash",
        format: "google-thought-signature",
      },
    ],
  },
  "gemini-3.7-flash": {
    support: "supported",
    emittedFormats: ["google-thought-signature"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [
      {
        provider: "google",
        model: "gemini-3.7-flash",
        format: "google-thought-signature",
      },
    ],
  },
  "gemini-3.6-flash": {
    support: "supported",
    emittedFormats: ["google-thought-signature"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [
      {
        provider: "google",
        model: "gemini-3.6-flash",
        format: "google-thought-signature",
      },
    ],
  },
  "gemini-3.5-flash-lite": {
    support: "supported",
    emittedFormats: ["google-thought-signature"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [
      {
        provider: "google",
        model: "gemini-3.5-flash-lite",
        format: "google-thought-signature",
      },
    ],
  },
  "gemini-3.1-pro-preview": {
    support: "supported",
    emittedFormats: ["google-thought-signature"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [
      {
        provider: "google",
        model: "gemini-3.1-pro-preview",
        format: "google-thought-signature",
      },
    ],
  },
  "gemini-3.5-flash": {
    support: "supported",
    emittedFormats: ["google-thought-signature"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [
      {
        provider: "google",
        model: "gemini-3.5-flash",
        format: "google-thought-signature",
      },
    ],
  },
  "gemini-3.1-flash-lite": {
    support: "supported",
    emittedFormats: ["google-thought-signature"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [
      {
        provider: "google",
        model: "gemini-3.1-flash-lite",
        format: "google-thought-signature",
      },
    ],
  },
  "openai/gpt-6.1-sol": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "openai/gpt-6-astra": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "openai/gpt-6-sol": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "openai/gpt-6-luna": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "openai/gpt-5.6-sol": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "openai/gpt-5.6-terra": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "openai/gpt-5.6-luna": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "google/gemini-3.8-flash": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "google/gemini-3.7-flash": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "google/gemini-3.6-flash": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "google/gemini-3.5-flash-lite": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "google/gemini-3.1-pro-preview": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "google/gemini-3.5-flash": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "google/gemini-3.1-flash-lite": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "anthropic/claude-sonnet-5.5": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "anthropic/claude-sonnet-5": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "anthropic/claude-opus-5": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "anthropic/claude-opus-4.8": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "anthropic/claude-sonnet-4.6": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "openai/gpt-5.5": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "openai/gpt-5.4-mini": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "gpt-6.1-sol": {
    support: "supported",
    emittedFormats: ["openai-encrypted-content"],
    openAIIncludeEncryptedContent: true,
    openAIStore: false,
    anthropicThinking: "none",
    replayCompatibility: [
      {
        provider: "openai",
        model: "gpt-6.1-sol",
        format: "openai-encrypted-content",
      },
    ],
  },
  "gpt-6-astra": {
    support: "supported",
    emittedFormats: ["openai-encrypted-content"],
    openAIIncludeEncryptedContent: true,
    openAIStore: false,
    anthropicThinking: "none",
    replayCompatibility: [
      {
        provider: "openai",
        model: "gpt-6-astra",
        format: "openai-encrypted-content",
      },
    ],
  },
  "gpt-6-sol": {
    support: "supported",
    emittedFormats: ["openai-encrypted-content"],
    openAIIncludeEncryptedContent: true,
    openAIStore: false,
    anthropicThinking: "none",
    replayCompatibility: [
      {
        provider: "openai",
        model: "gpt-6-sol",
        format: "openai-encrypted-content",
      },
    ],
  },
  "gpt-6-luna": {
    support: "supported",
    emittedFormats: ["openai-encrypted-content"],
    openAIIncludeEncryptedContent: true,
    openAIStore: false,
    anthropicThinking: "none",
    replayCompatibility: [
      {
        provider: "openai",
        model: "gpt-6-luna",
        format: "openai-encrypted-content",
      },
    ],
  },
  "gpt-5.6": {
    support: "supported",
    emittedFormats: ["openai-encrypted-content"],
    openAIIncludeEncryptedContent: true,
    openAIStore: false,
    anthropicThinking: "none",
    replayCompatibility: [
      {
        provider: "openai",
        model: "gpt-5.6",
        format: "openai-encrypted-content",
      },
    ],
  },
  "gpt-5.6-terra": {
    support: "supported",
    emittedFormats: ["openai-encrypted-content"],
    openAIIncludeEncryptedContent: true,
    openAIStore: false,
    anthropicThinking: "none",
    replayCompatibility: [
      {
        provider: "openai",
        model: "gpt-5.6-terra",
        format: "openai-encrypted-content",
      },
    ],
  },
  "gpt-5.6-luna": {
    support: "supported",
    emittedFormats: ["openai-encrypted-content"],
    openAIIncludeEncryptedContent: true,
    openAIStore: false,
    anthropicThinking: "none",
    replayCompatibility: [
      {
        provider: "openai",
        model: "gpt-5.6-luna",
        format: "openai-encrypted-content",
      },
    ],
  },
  "gpt-5.5": {
    support: "supported",
    emittedFormats: ["openai-encrypted-content"],
    openAIIncludeEncryptedContent: true,
    openAIStore: false,
    anthropicThinking: "none",
    replayCompatibility: [
      {
        provider: "openai",
        model: "gpt-5.5",
        format: "openai-encrypted-content",
      },
    ],
  },
  "gpt-5.4": {
    support: "supported",
    emittedFormats: ["openai-encrypted-content"],
    openAIIncludeEncryptedContent: true,
    openAIStore: false,
    anthropicThinking: "none",
    replayCompatibility: [
      {
        provider: "openai",
        model: "gpt-5.4",
        format: "openai-encrypted-content",
      },
    ],
  },
  "gpt-5.4-mini": {
    support: "supported",
    emittedFormats: ["openai-encrypted-content"],
    openAIIncludeEncryptedContent: true,
    openAIStore: false,
    anthropicThinking: "none",
    replayCompatibility: [
      {
        provider: "openai",
        model: "gpt-5.4-mini",
        format: "openai-encrypted-content",
      },
    ],
  },
  "gpt-5.4-nano": {
    support: "supported",
    emittedFormats: ["openai-encrypted-content"],
    openAIIncludeEncryptedContent: true,
    openAIStore: false,
    anthropicThinking: "none",
    replayCompatibility: [
      {
        provider: "openai",
        model: "gpt-5.4-nano",
        format: "openai-encrypted-content",
      },
    ],
  },
  "gpt-5.2": {
    support: "supported",
    emittedFormats: ["openai-encrypted-content"],
    openAIIncludeEncryptedContent: true,
    openAIStore: false,
    anthropicThinking: "none",
    replayCompatibility: [
      {
        provider: "openai",
        model: "gpt-5.2",
        format: "openai-encrypted-content",
      },
    ],
  },
  "claude-sonnet-5-5": {
    support: "supported",
    emittedFormats: ["anthropic-thinking-signature"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "adaptive",
    replayCompatibility: [
      {
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        format: "anthropic-thinking-signature",
      },
    ],
  },
  "claude-sonnet-5": {
    support: "supported",
    emittedFormats: ["anthropic-thinking-signature"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "adaptive",
    replayCompatibility: [
      {
        provider: "anthropic",
        model: "claude-sonnet-5",
        format: "anthropic-thinking-signature",
      },
    ],
  },
  "claude-fable-5-1": {
    support: "supported",
    emittedFormats: ["anthropic-thinking-signature"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "adaptive",
    replayCompatibility: [
      {
        provider: "anthropic",
        model: "claude-fable-5-1",
        format: "anthropic-thinking-signature",
      },
    ],
  },
  "claude-fable-5": {
    support: "supported",
    emittedFormats: ["anthropic-thinking-signature"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "adaptive",
    replayCompatibility: [
      {
        provider: "anthropic",
        model: "claude-fable-5",
        format: "anthropic-thinking-signature",
      },
    ],
  },
  "claude-opus-5-5": {
    support: "supported",
    emittedFormats: ["anthropic-thinking-signature"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "adaptive",
    replayCompatibility: [
      {
        provider: "anthropic",
        model: "claude-opus-5-5",
        format: "anthropic-thinking-signature",
      },
    ],
  },
  "claude-opus-5": {
    support: "supported",
    emittedFormats: ["anthropic-thinking-signature"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "adaptive",
    replayCompatibility: [
      {
        provider: "anthropic",
        model: "claude-opus-5",
        format: "anthropic-thinking-signature",
      },
    ],
  },
  "claude-opus-4-8": {
    support: "supported",
    emittedFormats: ["anthropic-thinking-signature"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "adaptive",
    replayCompatibility: [
      {
        provider: "anthropic",
        model: "claude-opus-4-8",
        format: "anthropic-thinking-signature",
      },
    ],
  },
  "claude-opus-4-7": {
    support: "supported",
    emittedFormats: ["anthropic-thinking-signature"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "adaptive",
    replayCompatibility: [
      {
        provider: "anthropic",
        model: "claude-opus-4-7",
        format: "anthropic-thinking-signature",
      },
    ],
  },
  "claude-sonnet-4-6": {
    support: "supported",
    emittedFormats: ["anthropic-thinking-signature"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "adaptive",
    replayCompatibility: [
      {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        format: "anthropic-thinking-signature",
      },
    ],
  },
  "claude-opus-4-6": {
    support: "supported",
    emittedFormats: ["anthropic-thinking-signature"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "adaptive",
    replayCompatibility: [
      {
        provider: "anthropic",
        model: "claude-opus-4-6",
        format: "anthropic-thinking-signature",
      },
    ],
  },
  "claude-haiku-5-5": {
    support: "supported",
    emittedFormats: ["anthropic-thinking-signature"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "adaptive",
    replayCompatibility: [
      {
        provider: "anthropic",
        model: "claude-haiku-5-5",
        format: "anthropic-thinking-signature",
      },
    ],
  },
  "us.anthropic.claude-haiku-5-5": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "claude-haiku-4-5-20251001": {
    support: "supported",
    emittedFormats: ["anthropic-thinking-signature"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "budget",
    replayCompatibility: [
      {
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        format: "anthropic-thinking-signature",
      },
    ],
  },
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "us.amazon.nova-pro-v1:0": {
    support: "unsupported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "us.amazon.nova-lite-v1:0": {
    support: "unsupported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "us.amazon.nova-micro-v1:0": {
    support: "unsupported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "openai.gpt-oss-120b-1:0": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "openai.gpt-oss-20b-1:0": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "mistral-large-4": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "mistral-large-latest": {
    support: "unsupported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "mistral-medium-latest": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "mistral-small-latest": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "gemini-2.5-flash": {
    support: "supported",
    emittedFormats: ["google-thought-signature"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [
      {
        provider: "google",
        model: "gemini-2.5-flash",
        format: "google-thought-signature",
      },
    ],
  },
  "gemini-2.5-pro": {
    support: "supported",
    emittedFormats: ["google-thought-signature"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [
      {
        provider: "google",
        model: "gemini-2.5-pro",
        format: "google-thought-signature",
      },
    ],
  },
  "gpt-4o-mini": {
    support: "unsupported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: false,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "gpt-4o": {
    support: "unsupported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: false,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
  "us.deepseek.r1-v1:0": {
    support: "supported",
    emittedFormats: ["none"],
    openAIIncludeEncryptedContent: false,
    openAIStore: null,
    anthropicThinking: "none",
    replayCompatibility: [],
  },
} as const satisfies Record<
  OfferedBYOKModelId | keyof typeof RETAINED_MODELS_DEV_RATE_ENTRIES,
  ModelReasoningCapabilities
>;
