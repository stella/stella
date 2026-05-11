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
import { hydrateFilePart } from "@/api/handlers/chat/upload-files";
import { classifyAIError } from "@/api/lib/ai-error";
import type { OrgAIConfig } from "@/api/lib/ai-models";
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

  const preparedMessages = await prepareMessagesForThirdParty({
    boundary: thirdPartyBoundary,
    messages,
  });

  if (Result.isError(preparedMessages)) {
    return new Response(
      JSON.stringify({
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
    execute: ({ writer }) => {
      const modelInfo = devModelId
        ? getModelInfoById(devModelId, orgAIConfig)
        : getModelInfoForRole("chat", orgAIConfig);
      const result = streamText({
        abortSignal,
        model: devModelId
          ? getModelById(devModelId, orgAIConfig)
          : getModelForRole("chat", orgAIConfig),
        temperature: getTemperatureForRole("chat"),
        system,
        tools: modelTools,
        experimental_repairToolCall: async ({ toolCall }) =>
          await Promise.resolve(repairActiveDocxEditToolCall(toolCall)),
        providerOptions: {
          openai: {
            promptCacheKey,
          },
        },
        stopWhen: [stepCountIs(MAX_TOOL_STEPS), hasToolCall("ask-user")],
        messages: modelMessages,
        onFinish: ({ finishReason, totalUsage }) => {
          // Some providers (notably gemini-2.5-flash-lite on cached
          // prefixes) return finish_reason=stop with zero output
          // tokens. The frontend predicate guards against the
          // resulting auto-resubmit storm, but the failure is
          // otherwise invisible — capture it so we can track which
          // models regress.
          // `outputTokens` is `number | undefined` — only fire when
          // explicitly zero, otherwise providers that omit usage
          // metadata would all be misclassified as empty.
          if (finishReason === "stop" && totalUsage.outputTokens === 0) {
            captureError(
              new ChatEmptyCompletionError({
                message: "Model returned finish_reason=stop with zero output",
              }),
              {
                threadId,
                provider: modelInfo.provider,
                modelId: modelInfo.modelId,
              },
            );
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
      writer.merge(
        thirdPartyBoundary.type === "anonymized"
          ? deanonymizeOutgoingStream(refResolved, thirdPartyBoundary)
          : refResolved,
      );
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
// …). Lowercase-leading `[` (e.g. markdown `[link text](url)`) is
// flushed without delay.
const PARTIAL_PLACEHOLDER_TAIL = /\[[A-Z][A-Z0-9_]*$/;

const getDeanonymisablePrefixLength = (text: string): number => {
  const match = PARTIAL_PLACEHOLDER_TAIL.exec(text);
  return match ? match.index : text.length;
};

export const deanonymizeOutgoingStream = (
  stream: ReadableStream<InferUIMessageChunk<ChatMessage>>,
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>,
) => {
  const buffers = new Map<string, string>();

  // Tracks which placeholders we've already pushed to the client
  // so subsequent emissions only carry the *new* pairs. The map on
  // the boundary keeps growing as tools run (their outputs get
  // anonymized through the same map), and the client's
  // `collectAnonRestorations` aggregates every
  // `data-stella-anon-restorations` part on the message — so each
  // delta is purely additive and ends up merged in the right order.
  const emittedPlaceholders = new Set<string>();

  const emitRestorationDelta = (
    controller: TransformStreamDefaultController<
      InferUIMessageChunk<ChatMessage>
    >,
  ) => {
    if (boundary.redactionMap.size === emittedPlaceholders.size) {
      return;
    }
    const newPairs: { placeholder: string; original: string }[] = [];
    for (const [placeholder, original] of boundary.redactionMap) {
      if (!emittedPlaceholders.has(placeholder)) {
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
        // Re-check on every chunk so placeholders introduced by
        // tool-output anonymization (or any other late call into
        // the boundary) show up as additional restoration parts.
        emitRestorationDelta(controller);
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
          controller.enqueue({
            ...chunk,
            output: deanonymizeUnknownStringsFromBoundary(
              boundary,
              chunk.output,
            ),
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

        if (refuseNonPlainTextFiles && file.mimeType !== TEXT_PLAIN_MIME_TYPE) {
          return Result.err(
            new HandlerError({
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
            s3Key: file.s3Key,
          }),
        );

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
