import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  hasToolCall,
  stepCountIs,
  streamText,
} from "ai";
import type {
  InferUIMessageChunk,
  LanguageModel,
  ToolSet,
  UIMessageStreamOnFinishCallback,
} from "ai";
import { panic, Result } from "better-result";

import type { SafeDb, SafeDbError } from "@/api/db";
import {
  getUserFileIdFromPart,
  TEXT_PLAIN_MIME_TYPE,
} from "@/api/handlers/chat/attachment-validation";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import {
  deanonymizeFromBoundary,
  deanonymizeUnknownStringsFromBoundary,
  prepareMessagesForThirdParty,
  prepareTextForThirdParty,
  prepareToolsForThirdParty,
} from "@/api/handlers/chat/third-party-boundary";
import { repairActiveDocxEditToolCall } from "@/api/handlers/chat/tools/active-docx-edit-tool-repair";
import type { ChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import type { ChatMessage } from "@/api/handlers/chat/types";
import {
  canHydrateFilePartAsPlainText,
  hydrateFilePart,
} from "@/api/handlers/chat/upload-files";
import { classifyAIError } from "@/api/lib/ai-error";
import type { OrgAIConfig, ResolvedModelInfo } from "@/api/lib/ai-models";
import {
  getModelById,
  getModelInfoById,
  getModelForRole,
  getModelInfoForRole,
  getTemperatureForRole,
} from "@/api/lib/ai-models";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import {
  ChatEmptyCompletionError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";

const MAX_TOOL_STEPS = 8;

type AssistantValueRefResolver = ChatRefRegistry["resolveAssistantValueRefs"];

type RunChatStreamArgs = {
  writer: Parameters<
    NonNullable<
      Parameters<typeof createUIMessageStream<ChatMessage>>[0]["execute"]
    >
  >[0]["writer"];
  model: LanguageModel;
  modelInfo: ResolvedModelInfo;
  /**
   * When true, an empty completion appends an `{type: "error"}`
   * chunk to the tail of the stream — `Chat.onFinish` then reports
   * `isError: true` and the frontend renders the recoverable error
   * bubble. When false, the empty case finishes silently so a
   * caller (the fallback path) can continue with a different
   * model on the same writer.
   */
  emitErrorOnEmpty: boolean;
  abortSignal: AbortSignal;
  system: string;
  tools: ToolSet;
  promptCacheKey: string;
  modelMessages: Awaited<ReturnType<typeof convertToModelMessages>>;
  threadId: SafeId<"chatThread">;
  thirdPartyBoundary: ChatThirdPartyBoundary;
  resolveAssistantTextRefs: ((text: string) => string) | undefined;
  resolveAssistantValueRefs: AssistantValueRefResolver | undefined;
  initialRestorationPlaceholders: ReadonlySet<string>;
  onAiError: (error: unknown) => string;
};

/**
 * One streamText invocation, threaded through the deanonymization
 * + ref-resolution pipeline and merged onto the shared writer.
 * Returns `true` if the model produced zero output tokens — the
 * caller decides whether to retry on a fallback model or surface
 * the error.
 */
const runChatStream = async ({
  writer,
  model,
  modelInfo,
  emitErrorOnEmpty,
  abortSignal,
  system,
  tools,
  promptCacheKey,
  modelMessages,
  threadId,
  thirdPartyBoundary,
  resolveAssistantTextRefs,
  resolveAssistantValueRefs,
  initialRestorationPlaceholders,
  onAiError,
}: RunChatStreamArgs): Promise<boolean> => {
  let emptyCompletion: ChatEmptyCompletionError | null = null;
  let flushResolve: (() => void) | null = null;
  const flushed = new Promise<void>((resolve) => {
    flushResolve = resolve;
  });
  const result = streamText({
    abortSignal,
    model,
    temperature: getTemperatureForRole("chat"),
    system,
    tools,
    experimental_repairToolCall: async ({ toolCall }) =>
      await Promise.resolve(repairActiveDocxEditToolCall(toolCall)),
    providerOptions: {
      openai: { promptCacheKey },
    },
    stopWhen: [stepCountIs(MAX_TOOL_STEPS), hasToolCall("ask-user")],
    messages: modelMessages,
    onFinish: ({ finishReason, totalUsage }) => {
      // `outputTokens` is `number | undefined` — only fire when
      // explicitly zero, otherwise providers that omit usage
      // metadata would all be misclassified as empty.
      if (finishReason === "stop" && totalUsage.outputTokens === 0) {
        emptyCompletion = new ChatEmptyCompletionError({
          message: "Model returned finish_reason=stop with zero output",
        });
        captureError(emptyCompletion, {
          threadId,
          provider: modelInfo.provider,
          modelId: modelInfo.modelId,
        });
      }
    },
  });

  const uiStream = result.toUIMessageStream<ChatMessage>({
    onError: onAiError,
  });
  const refResolved = resolveAssistantTextRefs
    ? resolveRefsInTextStream(
        uiStream,
        resolveAssistantTextRefs,
        resolveAssistantValueRefs,
      )
    : uiStream;
  const piped =
    thirdPartyBoundary.type === "anonymized"
      ? deanonymizeOutgoingStream(refResolved, thirdPartyBoundary, {
          initialRestorationPlaceholders,
        })
      : refResolved;
  // Terminal-flush transform: when `emitErrorOnEmpty` and the
  // model returned empty, append the error chunk so the client
  // sees a clear failure. The flush also resolves `flushed`, which
  // we await below to know when the pipeline has fully drained.
  const finalised = piped.pipeThrough(
    new TransformStream<
      InferUIMessageChunk<ChatMessage>,
      InferUIMessageChunk<ChatMessage>
    >({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (emptyCompletion && emitErrorOnEmpty) {
          controller.enqueue({
            type: "error",
            errorText: onAiError(emptyCompletion),
          });
        }
        flushResolve?.();
      },
    }),
  );
  writer.merge(finalised);
  await flushed;
  return emptyCompletion !== null;
};

type StoredUserFile = {
  id: SafeId<"userFile">;
  userId: string;
  threadId: SafeId<"chatThread">;
  fileName: string;
  mimeType: string;
  s3Key: string;
};

type StreamChatProps = {
  abortSignal: AbortSignal;
  devModelId?: string | undefined;
  messages: ChatMessage[];
  onFinish: UIMessageStreamOnFinishCallback<ChatMessage>;
  orgAIConfig: OrgAIConfig | null;
  promptCacheKey: string;
  resolveAssistantTextRefs?: ((text: string) => string) | undefined;
  resolveAssistantValueRefs?: AssistantValueRefResolver | undefined;
  /**
   * Server-built scaffold half of the system prompt. Sent to the
   * model verbatim.
   */
  systemSafe: string;
  /**
   * Dynamic, user-supplied half of the system prompt (active file
   * body, decision text, external source content, matter labels).
   * In anonymized mode this passes through the boundary first;
   * otherwise it concatenates straight onto `systemSafe`.
   */
  systemUntrusted: string;
  thirdPartyBoundary: ChatThirdPartyBoundary;
  threadId: SafeId<"chatThread">;
  tools: ToolSet;
};

export const streamChat = async ({
  abortSignal,
  devModelId,
  messages,
  onFinish,
  orgAIConfig,
  promptCacheKey,
  resolveAssistantTextRefs,
  resolveAssistantValueRefs,
  systemSafe,
  systemUntrusted,
  thirdPartyBoundary,
  threadId,
  tools,
}: StreamChatProps) => {
  // The prompt builder already split the system prompt into a safe
  // scaffold half (brand voice, skill catalog, jurisdictions) and
  // a dynamic-context half (active file body, decision text,
  // external source, matter labels). Only the dynamic half can
  // carry third-party PII, so it's the only piece that crosses the
  // boundary; the scaffold concatenates onto the front unchanged.
  const preparedUntrusted = await prepareTextForThirdParty({
    boundary: thirdPartyBoundary,
    text: systemUntrusted,
  });
  if (Result.isError(preparedUntrusted)) {
    return new Response(
      JSON.stringify({
        code: "third_party_boundary_refusal",
        message: preparedUntrusted.error.message,
        type: "third_party_boundary_refusal",
      }),
      {
        headers: { "Content-Type": "application/json" },
        status: preparedUntrusted.error.status,
      },
    );
  }
  const system =
    preparedUntrusted.value.length > 0
      ? `${systemSafe}${preparedUntrusted.value.startsWith("\n") ? "" : "\n\n"}${preparedUntrusted.value}`
      : systemSafe;
  const systemOnlyPlaceholders =
    thirdPartyBoundary.type === "anonymized"
      ? new Set(thirdPartyBoundary.redactionMap.keys())
      : new Set<string>();

  const preparedMessages = await prepareMessagesForThirdParty({
    boundary: thirdPartyBoundary,
    messages,
  });

  if (Result.isError(preparedMessages)) {
    return new Response(
      JSON.stringify({
        code: "third_party_boundary_refusal",
        message: preparedMessages.error.message,
        type: "third_party_boundary_refusal",
      }),
      {
        headers: { "Content-Type": "application/json" },
        status: preparedMessages.error.status,
      },
    );
  }

  const modelMessages = await convertToModelMessages(preparedMessages.value);
  const initialRestorationPlaceholders =
    thirdPartyBoundary.type === "anonymized"
      ? collectRestorationPlaceholders({
          exclude: systemOnlyPlaceholders,
          redactionMap: thirdPartyBoundary.redactionMap,
        })
      : new Set<string>();
  const modelTools = prepareToolsForThirdParty({
    boundary: thirdPartyBoundary,
    tools,
  });
  // The AI SDK runs error formatting in two places: the outer
  // `createUIMessageStream({ onError })` for errors thrown inside
  // `execute`, and the inner `result.toUIMessageStream({ onError })`
  // for errors emitted by the model stream itself. The inner one
  // defaults to `() => "An error occurred."` and *that* is the path a
  // Gemini-quota / OpenRouter-credits failure actually takes — without
  // wiring the same classifier on both, the chat client sees the
  // generic string and our frontend kind-mapping never fires.
  const onAiError = (error: unknown): string => {
    const kind = classifyAIError(error);
    captureError(error, { threadId, kind });
    return kind;
  };

  const stream = createUIMessageStream<ChatMessage>({
    generateId: () => Bun.randomUUIDv7(),
    originalMessages: preparedMessages.value,
    onFinish,
    onError: onAiError,
    execute: async ({ writer }) => {
      const primaryInfo = devModelId
        ? getModelInfoById(devModelId, orgAIConfig)
        : getModelInfoForRole("chat", orgAIConfig);
      const primaryModel = devModelId
        ? getModelById(devModelId, orgAIConfig)
        : getModelForRole("chat", orgAIConfig);
      // Eligible fallback: a *different* model on the same orgAI
      // config. Skip when the user has pinned a specific dev
      // override (their choice is authoritative) and when the
      // reasoning role resolves to the same id as chat (e.g.
      // anthropic — claude-sonnet-4-6 for both; same on
      // openai_compatible's "default").
      const fallbackInfo: ResolvedModelInfo | null =
        devModelId === undefined
          ? getModelInfoForRole("reasoning", orgAIConfig)
          : null;
      const fallbackEligible =
        fallbackInfo !== null && fallbackInfo.modelId !== primaryInfo.modelId;

      const primaryEmpty = await runChatStream({
        writer,
        model: primaryModel,
        modelInfo: primaryInfo,
        // Primary finalises on empty only when there's no fallback
        // — otherwise the fallback path emits the terminal error.
        emitErrorOnEmpty: !fallbackEligible,
        abortSignal,
        system,
        tools: modelTools,
        promptCacheKey,
        modelMessages,
        threadId,
        thirdPartyBoundary,
        resolveAssistantTextRefs,
        resolveAssistantValueRefs,
        initialRestorationPlaceholders,
        onAiError,
      });

      if (primaryEmpty && fallbackEligible && fallbackInfo !== null) {
        // Same conversation, different model. If the fallback also
        // returns empty we surface the error chunk; one automatic
        // retry on a different model is bounded and recoverable,
        // unlike the model-keeps-failing-on-cached-prefix case.
        const fallbackModel = getModelForRole("reasoning", orgAIConfig);
        await runChatStream({
          writer,
          model: fallbackModel,
          modelInfo: fallbackInfo,
          emitErrorOnEmpty: true,
          abortSignal,
          system,
          tools: modelTools,
          promptCacheKey,
          modelMessages,
          threadId,
          thirdPartyBoundary,
          resolveAssistantTextRefs,
          resolveAssistantValueRefs,
          initialRestorationPlaceholders,
          onAiError,
        });
      }
    },
  });

  return createUIMessageStreamResponse({
    stream,
  });
};

const STELLA_REF_MARKER = "#stella-";

const getResolvedTextPrefixLength = (text: string) => {
  const markerIndex = text.lastIndexOf(STELLA_REF_MARKER);
  if (markerIndex === -1) {
    return text.length;
  }

  const markerSuffix = text.slice(markerIndex);
  return /[\s)]/.test(markerSuffix) ? text.length : markerIndex;
};

// A token like `[PERSON_1]` may straddle two text deltas. Hold back
// any tail that *could* be the opening of a placeholder until the
// closing `]` arrives or the stream completes — otherwise the user
// briefly sees `[PERSON_1]` before it snaps to the real name.
//
// `[A-Z][A-Z0-9_]*` is the smallest superset of the wasm pipeline's
// "replace" operator output (`[PERSON_1]`, `[ORG_3]`, `[CUSTOM_2]`,
// …). The `\[$` alternative also buffers a *lone* trailing `[`,
// because the first char after the bracket can land in the next
// delta — without it, `"foo ["` flushes immediately and the next
// `"PERSON_1] bar"` chunk never sees `[PERSON_1]` to deanonymize.
// The one-delta latency penalty for markdown `[link text](url)`
// is acceptable; once the next char arrives it's lowercase, the
// regex stops matching, and the buffered `[` flushes.
const PARTIAL_PLACEHOLDER_TAIL = /\[[A-Z][A-Z0-9_]*$|\[$/;
const PLACEHOLDER_TOKEN = /\[[A-Z][A-Z0-9_]*]/g;

const getDeanonymisablePrefixLength = (text: string): number => {
  const match = PARTIAL_PLACEHOLDER_TAIL.exec(text);
  return match ? match.index : text.length;
};

const collectRestorationPlaceholders = ({
  exclude = new Set<string>(),
  redactionMap,
}: {
  redactionMap: ReadonlyMap<string, string>;
  exclude?: ReadonlySet<string> | undefined;
}): Set<string> => {
  const placeholders = new Set<string>();
  for (const placeholder of redactionMap.keys()) {
    if (!exclude.has(placeholder)) {
      placeholders.add(placeholder);
    }
  }
  return placeholders;
};

const collectTextPlaceholders = (text: string): Set<string> => {
  const placeholders = new Set<string>();
  PLACEHOLDER_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_TOKEN.exec(text)) !== null) {
    placeholders.add(match[0]);
  }
  return placeholders;
};

const collectUnknownStringPlaceholders = (value: unknown): Set<string> => {
  const placeholders = new Set<string>();
  const walk = (next: unknown): void => {
    if (typeof next === "string") {
      for (const placeholder of collectTextPlaceholders(next)) {
        placeholders.add(placeholder);
      }
      return;
    }
    if (Array.isArray(next)) {
      for (const item of next) {
        walk(item);
      }
      return;
    }
    if (typeof next !== "object" || next === null) {
      return;
    }
    for (const nested of Object.values(next)) {
      walk(nested);
    }
  };
  walk(value);
  return placeholders;
};

export const deanonymizeOutgoingStream = (
  stream: ReadableStream<InferUIMessageChunk<ChatMessage>>,
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>,
  {
    initialRestorationPlaceholders = new Set<string>(),
  }: {
    initialRestorationPlaceholders?: ReadonlySet<string> | undefined;
  } = {},
) => {
  const buffers = new Map<string, string>();

  // Tracks which placeholders we've already pushed to the client
  // so subsequent emissions only carry the *new* pairs. Initial
  // placeholders come from provider-visible chat messages; later
  // placeholders are emitted only when they appear in user-visible
  // assistant/tool chunks. System-context-only placeholders stay on
  // the server map for deanonymization but are not persisted into
  // chat history.
  const emittedPlaceholders = new Set<string>();

  const emitRestorationDelta = (
    controller: TransformStreamDefaultController<
      InferUIMessageChunk<ChatMessage>
    >,
    placeholders: ReadonlySet<string>,
  ) => {
    if (placeholders.size === 0) {
      return;
    }
    const newPairs: { placeholder: string; original: string }[] = [];
    for (const placeholder of placeholders) {
      if (emittedPlaceholders.has(placeholder)) {
        continue;
      }
      const original = boundary.redactionMap.get(placeholder);
      if (original !== undefined) {
        emittedPlaceholders.add(placeholder);
        newPairs.push({ placeholder, original });
      }
    }
    if (newPairs.length === 0) {
      return;
    }
    controller.enqueue({
      type: "data-stella-anon-restorations" as const,
      data: { pairs: newPairs },
    } satisfies InferUIMessageChunk<ChatMessage>);
  };

  const flushText = ({
    controller,
    id,
    text,
  }: {
    controller: TransformStreamDefaultController<
      InferUIMessageChunk<ChatMessage>
    >;
    id: string;
    text: string;
  }) => {
    if (text.length === 0) {
      return;
    }
    emitRestorationDelta(controller, collectTextPlaceholders(text));
    controller.enqueue({
      type: "text-delta",
      id,
      delta: deanonymizeFromBoundary({ boundary, text }),
    });
  };

  return stream.pipeThrough(
    new TransformStream<
      InferUIMessageChunk<ChatMessage>,
      InferUIMessageChunk<ChatMessage>
    >({
      transform(chunk, controller) {
        emitRestorationDelta(controller, initialRestorationPlaceholders);
        if (chunk.type === "text-delta") {
          const buffer = `${buffers.get(chunk.id) ?? ""}${chunk.delta}`;
          const prefixLength = getDeanonymisablePrefixLength(buffer);
          flushText({
            controller,
            id: chunk.id,
            text: buffer.slice(0, prefixLength),
          });
          buffers.set(chunk.id, buffer.slice(prefixLength));
          return;
        }

        if (chunk.type === "text-end") {
          flushText({
            controller,
            id: chunk.id,
            text: buffers.get(chunk.id) ?? "",
          });
          buffers.delete(chunk.id);
          controller.enqueue(chunk);
          return;
        }

        if (chunk.type === "tool-output-available") {
          emitRestorationDelta(
            controller,
            collectUnknownStringPlaceholders(chunk.output),
          );
          controller.enqueue({
            ...chunk,
            output: deanonymizeUnknownStringsFromBoundary(
              boundary,
              chunk.output,
            ),
          });
          return;
        }

        // Tool *input* chunks carry text the LLM writes into its
        // tool arguments — for `ask-user` that's the question and
        // option labels rendered to the user. Without rehydration
        // here, the card shows raw `[PERSON_N]` instead of the
        // original name. Same partial-placeholder buffering as
        // text-delta so a placeholder split across deltas isn't
        // emitted half-formed.
        if (chunk.type === "tool-input-delta") {
          const key = `tool-input:${chunk.toolCallId}`;
          const buffer = `${buffers.get(key) ?? ""}${chunk.inputTextDelta}`;
          const prefixLength = getDeanonymisablePrefixLength(buffer);
          const flushable = buffer.slice(0, prefixLength);
          buffers.set(key, buffer.slice(prefixLength));
          if (flushable.length > 0) {
            emitRestorationDelta(
              controller,
              collectTextPlaceholders(flushable),
            );
            controller.enqueue({
              ...chunk,
              inputTextDelta: deanonymizeFromBoundary({
                boundary,
                text: flushable,
              }),
            });
          }
          return;
        }

        if (chunk.type === "tool-input-available") {
          const key = `tool-input:${chunk.toolCallId}`;
          const pending = buffers.get(key);
          if (pending !== undefined && pending.length > 0) {
            emitRestorationDelta(controller, collectTextPlaceholders(pending));
            controller.enqueue({
              type: "tool-input-delta",
              toolCallId: chunk.toolCallId,
              inputTextDelta: deanonymizeFromBoundary({
                boundary,
                text: pending,
              }),
            });
            buffers.delete(key);
          }
          emitRestorationDelta(
            controller,
            collectUnknownStringPlaceholders(chunk.input),
          );
          controller.enqueue({
            ...chunk,
            input: deanonymizeUnknownStringsFromBoundary(boundary, chunk.input),
          });
          return;
        }

        controller.enqueue(chunk);
      },
    }),
  );
};

export const resolveRefsInTextStream = (
  stream: ReadableStream<InferUIMessageChunk<ChatMessage>>,
  resolveAssistantTextRefs: (text: string) => string,
  resolveAssistantValueRefs?: AssistantValueRefResolver,
) => {
  const buffers = new Map<string, string>();

  const flushText = ({
    controller,
    id,
    text,
  }: {
    controller: TransformStreamDefaultController<
      InferUIMessageChunk<ChatMessage>
    >;
    id: string;
    text: string;
  }) => {
    if (text.length === 0) {
      return;
    }

    controller.enqueue({
      type: "text-delta",
      id,
      delta: resolveAssistantTextRefs(text),
    });
  };

  return stream.pipeThrough(
    new TransformStream<
      InferUIMessageChunk<ChatMessage>,
      InferUIMessageChunk<ChatMessage>
    >({
      transform(chunk, controller) {
        if (chunk.type === "text-delta") {
          const buffer = `${buffers.get(chunk.id) ?? ""}${chunk.delta}`;
          const prefixLength = getResolvedTextPrefixLength(buffer);
          flushText({
            controller,
            id: chunk.id,
            text: buffer.slice(0, prefixLength),
          });
          buffers.set(chunk.id, buffer.slice(prefixLength));
          return;
        }

        if (chunk.type === "text-end") {
          flushText({
            controller,
            id: chunk.id,
            text: buffers.get(chunk.id) ?? "",
          });
          buffers.delete(chunk.id);
        }

        if (
          chunk.type === "tool-output-available" &&
          resolveAssistantValueRefs
        ) {
          controller.enqueue({
            ...chunk,
            output: resolveAssistantValueRefs(chunk.output),
          });
          return;
        }

        controller.enqueue(chunk);
      },
    }),
  );
};

type HydrateMessagesProps = {
  messages: ChatMessage[];
  refuseNonPlainTextFiles?: boolean | undefined;
  safeDb: SafeDb;
  userId: SafeId<"user">;
};

export const hydrateMessages = async ({
  messages,
  refuseNonPlainTextFiles = false,
  safeDb,
  userId,
}: HydrateMessagesProps) =>
  await Result.gen(async function* () {
    const userFilesById = yield* Result.await(
      readUserFilesByIds({
        messages,
        safeDb,
        userId,
      }),
    );
    const hydratedMessages: ChatMessage[] = [];

    for (const message of messages) {
      const parts: ChatMessage["parts"] = [];

      for (const part of message.parts) {
        if (part.type !== "file") {
          parts.push(part);
          continue;
        }

        const fileIdResult = getUserFileIdFromPart(part);
        if (Result.isError(fileIdResult)) {
          panic("Persisted chat file part did not use a valid user-file URL");
        }

        const file = userFilesById.get(fileIdResult.value);
        if (!file) {
          panic("Persisted chat file reference missing user_files row");
        }

        if (
          refuseNonPlainTextFiles &&
          !canHydrateFilePartAsPlainText(file.mimeType)
        ) {
          return Result.err(
            new HandlerError({
              code: "third_party_boundary_refusal",
              status: 422,
              message:
                "Cannot send this attachment to the AI in anonymized mode because Stella cannot extract and anonymize it safely.",
            }),
          );
        }

        const hydratedPart = yield* Result.await(
          hydrateFilePart({
            // eslint-disable-next-line security-guards/no-raw-filename-write -- DB read-back from user_files, already sanitized on upload
            fileName: file.fileName,
            mimeType: file.mimeType,
            plainTextOnly: refuseNonPlainTextFiles,
            s3Key: file.s3Key,
          }),
        );

        if (
          refuseNonPlainTextFiles &&
          hydratedPart.mediaType !== TEXT_PLAIN_MIME_TYPE
        ) {
          return Result.err(
            new HandlerError({
              code: "third_party_boundary_refusal",
              status: 422,
              message:
                "Cannot send this attachment to the AI in anonymized mode because Stella cannot extract and anonymize it safely.",
            }),
          );
        }

        parts.push(hydratedPart);
      }

      hydratedMessages.push({
        ...message,
        parts,
      });
    }

    return Result.ok(hydratedMessages);
  });

type ReadUserFilesByIdsProps = {
  messages: ChatMessage[];
  safeDb: SafeDb;
  userId: SafeId<"user">;
};

const readUserFilesByIds = async ({
  messages,
  safeDb,
  userId,
}: ReadUserFilesByIdsProps): Promise<
  Result<Map<SafeId<"userFile">, StoredUserFile>, SafeDbError>
> => {
  const ids = collectMessageUserFileIds(messages);

  if (ids.length === 0) {
    return Result.ok(new Map<SafeId<"userFile">, StoredUserFile>());
  }

  const rowsResult = await safeDb((tx) =>
    tx.query.userFiles.findMany({
      where: {
        id: { in: ids },
        userId: { eq: userId },
      },
      columns: {
        id: true,
        userId: true,
        threadId: true,
        fileName: true,
        mimeType: true,
        s3Key: true,
      },
    }),
  );

  return rowsResult.map((rows) => new Map(rows.map((row) => [row.id, row])));
};

const collectMessageUserFileIds = (
  messages: readonly ChatMessage[],
): SafeId<"userFile">[] => {
  const ids = new Set<SafeId<"userFile">>();

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "file") {
        continue;
      }

      const fileIdResult = getUserFileIdFromPart(part);
      if (Result.isError(fileIdResult)) {
        panic("Persisted chat file part did not use a valid user-file URL");
      }

      ids.add(fileIdResult.value);
    }
  }

  return [...ids];
};
