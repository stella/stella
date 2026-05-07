import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  hasToolCall,
  stepCountIs,
  streamText,
} from "ai";
import type { InferUIMessageChunk, UIMessageStreamOnFinishCallback } from "ai";
import { panic, Result } from "better-result";

import type { SafeDb, SafeDbError } from "@/api/db";
import {
  getUserFileIdFromPart,
  TEXT_PLAIN_MIME_TYPE,
} from "@/api/handlers/chat/attachment-validation";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import {
  prepareMessagesForThirdParty,
  prepareTextForThirdParty,
  prepareToolsForThirdParty,
} from "@/api/handlers/chat/third-party-boundary";
import { repairActiveDocxEditToolCall } from "@/api/handlers/chat/tools/active-docx-edit-tool-repair";
import type { ChatTools } from "@/api/handlers/chat/tools/chat-tools";
import type { ChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { hydrateFilePart } from "@/api/handlers/chat/upload-files";
import { classifyAIError } from "@/api/lib/ai-error";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import {
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
  messages: ChatMessage[];
  onFinish: UIMessageStreamOnFinishCallback<ChatMessage>;
  orgAIConfig: OrgAIConfig | null;
  promptCacheKey: string;
  resolveAssistantTextRefs?: ((text: string) => string) | undefined;
  resolveAssistantValueRefs?: AssistantValueRefResolver | undefined;
  system: string;
  thirdPartyBoundary: ChatThirdPartyBoundary;
  threadId: SafeId<"chatThread">;
  tools: Partial<ChatTools>;
};

export const streamChat = async ({
  abortSignal,
  messages,
  onFinish,
  orgAIConfig,
  promptCacheKey,
  resolveAssistantTextRefs,
  resolveAssistantValueRefs,
  system,
  thirdPartyBoundary,
  threadId,
  tools,
}: StreamChatProps) => {
  const [preparedMessages, preparedSystem] = await Promise.all([
    prepareMessagesForThirdParty({
      boundary: thirdPartyBoundary,
      messages,
    }),
    prepareTextForThirdParty({
      boundary: thirdPartyBoundary,
      text: system,
    }),
  ]);

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

  if (Result.isError(preparedSystem)) {
    return new Response(
      JSON.stringify({
        message: preparedSystem.error.message,
        type: "third_party_boundary_refusal",
      }),
      {
        headers: { "Content-Type": "application/json" },
        status: preparedSystem.error.status,
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
      const modelInfo = getModelInfoForRole("chat", orgAIConfig);
      const result = streamText({
        abortSignal,
        model: getModelForRole("chat", orgAIConfig),
        temperature: getTemperatureForRole("chat"),
        system: preparedSystem.value,
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
      writer.merge(
        resolveAssistantTextRefs
          ? resolveRefsInTextStream(
              uiStream,
              resolveAssistantTextRefs,
              resolveAssistantValueRefs,
            )
          : uiStream,
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
