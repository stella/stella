import { TaggedError } from "better-result";

import { AI_PROVIDERS } from "@stll/ai-catalog";
import type { AIProvider, ReasoningEffort } from "@stll/ai-catalog";

export type ChatModelOption = {
  defaultReasoningEffort: ReasoningEffort | null;
  displayName: string;
  modelId: string;
  provider: AIProvider;
  reasoningEfforts: readonly ReasoningEffort[] | null;
};

export type ChatModelSelection = {
  modelId: string | null;
  provider: AIProvider | null;
  reasoningEffort: ReasoningEffort | null;
};

export type ChatProviderConfiguration = {
  modelIds: readonly string[];
  provider: AIProvider;
};

export class ChatConfigurationError extends TaggedError(
  "ChatConfigurationError",
)<{
  code:
    | "duplicate-model"
    | "empty-model-id"
    | "empty-provider"
    | "unknown-provider"
    | "unconfigured-model";
  message: string;
  modelId?: string | undefined;
  provider?: string | undefined;
}> {}

export class ChatStreamError extends TaggedError("ChatStreamError")<{
  cause: unknown;
  message: string;
}> {}

const providerSet: ReadonlySet<string> = new Set(AI_PROVIDERS);

const modelKey = (provider: AIProvider, modelId: string): string =>
  `${provider}:${modelId}`;

/**
 * Validate provider configuration at the shell boundary. A missing or unknown
 * provider/model is an explicit typed error: the runtime never guesses a
 * provider or silently routes a request somewhere else.
 */
export const resolveChatModelSelection = ({
  providers,
  selection,
}: {
  providers: readonly ChatProviderConfiguration[];
  selection: ChatModelSelection;
}): ChatModelSelection => {
  const configuredModels = new Set<string>();
  for (const provider of providers) {
    if (!providerSet.has(provider.provider)) {
      throw new ChatConfigurationError({
        code: "unknown-provider",
        message: `Unknown AI provider: ${provider.provider}.`,
        provider: provider.provider,
      });
    }
    if (provider.modelIds.length === 0) {
      throw new ChatConfigurationError({
        code: "empty-provider",
        message: `AI provider ${provider.provider} has no configured models.`,
        provider: provider.provider,
      });
    }
    for (const modelId of provider.modelIds) {
      if (modelId.trim().length === 0) {
        throw new ChatConfigurationError({
          code: "empty-model-id",
          message: `AI provider ${provider.provider} has an empty model ID.`,
          provider: provider.provider,
        });
      }
      const key = modelKey(provider.provider, modelId);
      if (configuredModels.has(key)) {
        throw new ChatConfigurationError({
          code: "duplicate-model",
          message: `AI model ${modelId} is configured more than once for ${provider.provider}.`,
          modelId,
          provider: provider.provider,
        });
      }
      configuredModels.add(key);
    }
  }

  if (selection.modelId === null || selection.provider === null) {
    if (selection.modelId === null && selection.provider === null) {
      return selection;
    }
    throw new ChatConfigurationError({
      code: "unconfigured-model",
      message: "A model selection must include both provider and model ID.",
      modelId: selection.modelId ?? undefined,
      provider: selection.provider ?? undefined,
    });
  }

  if (!configuredModels.has(modelKey(selection.provider, selection.modelId))) {
    throw new ChatConfigurationError({
      code: "unconfigured-model",
      message: `AI model ${selection.modelId} is not configured for ${selection.provider}.`,
      modelId: selection.modelId,
      provider: selection.provider,
    });
  }
  return selection;
};

export type ChatMessage<Metadata = undefined> = {
  content: string;
  id: string;
  metadata: Metadata;
  role: "assistant" | "system" | "user";
};

export type ChatStreamEvent<Metadata = undefined> =
  | { message: ChatMessage<Metadata>; type: "message" }
  | { message: ChatMessage<Metadata>; type: "replace-message" };

export type ChatTransport<Metadata = undefined> = (input: {
  messages: readonly ChatMessage<Metadata>[];
  signal: AbortSignal;
}) => AsyncIterable<ChatStreamEvent<Metadata>>;

export type ChatRuntimeSnapshot<Metadata = undefined> = {
  error: ChatStreamError | undefined;
  isStreaming: boolean;
  messages: readonly ChatMessage<Metadata>[];
};

export type ChatRuntime<Metadata = undefined> = {
  getSnapshot: () => ChatRuntimeSnapshot<Metadata>;
  send: (message: ChatMessage<Metadata>) => Promise<void>;
  stop: () => void;
  subscribe: (listener: () => void) => () => void;
};

const toStreamError = (error: unknown): ChatStreamError =>
  error instanceof ChatStreamError
    ? error
    : new ChatStreamError({
        cause: error,
        message: error instanceof Error ? error.message : "Chat stream failed.",
      });

/**
 * A framework-neutral stream runtime. Hosts own authentication, endpoint
 * selection, persistence, and provider credentials through `transport`; this
 * primitive owns the observable stream lifecycle and makes failures explicit.
 */
export const createChatRuntime = <Metadata = undefined>({
  initialMessages = [],
  transport,
}: {
  initialMessages?: readonly ChatMessage<Metadata>[];
  transport: ChatTransport<Metadata>;
}): ChatRuntime<Metadata> => {
  const listeners = new Set<() => void>();
  let abortController: AbortController | undefined;
  let snapshot: ChatRuntimeSnapshot<Metadata> = {
    error: undefined,
    isStreaming: false,
    messages: initialMessages,
  };

  const emit = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const update = (next: ChatRuntimeSnapshot<Metadata>) => {
    snapshot = next;
    emit();
  };

  return {
    getSnapshot: () => snapshot,
    send: async (message) => {
      if (snapshot.isStreaming) {
        throw new ChatStreamError({
          cause: undefined,
          message: "A chat stream is already active.",
        });
      }
      const controller = new AbortController();
      abortController = controller;
      update({
        error: undefined,
        isStreaming: true,
        messages: [...snapshot.messages, message],
      });
      try {
        for await (const event of transport({
          messages: snapshot.messages,
          signal: controller.signal,
        })) {
          // A transport may ignore AbortSignal briefly. Once this request has
          // been stopped or superseded, its late events must not overwrite the
          // active stream's snapshot.
          if (abortController !== controller) {
            return;
          }
          const messages =
            event.type === "message"
              ? [...snapshot.messages, event.message]
              : snapshot.messages.map((candidate) =>
                  candidate.id === event.message.id ? event.message : candidate,
                );
          update({ error: undefined, isStreaming: true, messages });
        }
        if (abortController === controller) {
          abortController = undefined;
          update({ ...snapshot, isStreaming: false });
        }
      } catch (error) {
        if (abortController !== controller) {
          return;
        }
        abortController = undefined;
        update({
          error: toStreamError(error),
          isStreaming: false,
          messages: snapshot.messages,
        });
      }
    },
    stop: () => {
      abortController?.abort();
      abortController = undefined;
      if (snapshot.isStreaming) {
        update({ ...snapshot, isStreaming: false });
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
