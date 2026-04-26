import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  hasToolCall,
  stepCountIs,
  streamText,
} from "ai";
import { panic, Result } from "better-result";

import type { SafeDb, SafeDbError } from "@/api/db";
import { getUserFileIdFromPart } from "@/api/handlers/chat/attachment-validation";
import type { ChatTools } from "@/api/handlers/chat/tools/chat-tools";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { hydrateFilePart } from "@/api/handlers/chat/upload-files";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { getModelForRole, getTemperatureForRole } from "@/api/lib/ai-models";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";

const MAX_TOOL_STEPS = 8;

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
  onFinish: (messages: ChatMessage[]) => Promise<void>;
  orgAIConfig: OrgAIConfig | null;
  system: string;
  threadId: SafeId<"chatThread">;
  tools: ChatTools;
};

export const streamChat = async ({
  abortSignal,
  messages,
  onFinish,
  orgAIConfig,
  system,
  threadId,
  tools,
}: StreamChatProps) => {
  const modelMessages = await convertToModelMessages(messages);
  const emittedSourceDocumentIds = new Set<string>();
  const stream = createUIMessageStream<ChatMessage>({
    generateId: () => Bun.randomUUIDv7(),
    originalMessages: messages,
    onFinish: async ({ messages: streamedMessages }) => {
      await onFinish(streamedMessages);
    },
    onError: (error) => {
      captureError(error, { threadId });
      return "error";
    },
    execute: ({ writer }) => {
      const result = streamText({
        abortSignal,
        model: getModelForRole("chat", orgAIConfig),
        temperature: getTemperatureForRole("chat"),
        system,
        tools,
        stopWhen: [stepCountIs(MAX_TOOL_STEPS), hasToolCall("ask-user")],
        messages: modelMessages,
        onStepFinish: ({ toolResults }) => {
          for (const toolResult of toolResults) {
            if (!toolResult || toolResult.dynamic === true) {
              continue;
            }

            // oxlint-disable-next-line default-case, typescript/switch-exhaustiveness-check
            switch (toolResult.toolName) {
              case "read-entity":
              case "read-content":
              case "read-content-across-matters": {
                const { output } = toolResult;
                const sourceDocument = output.sourceDocument;
                if (emittedSourceDocumentIds.has(sourceDocument.entityId)) {
                  continue;
                }

                emittedSourceDocumentIds.add(sourceDocument.entityId);
                writer.write({
                  type: "data-stella-source-document",
                  id: sourceDocument.entityId,
                  data: sourceDocument,
                });
                break;
              }
            }
          }
        },
      });

      writer.merge(result.toUIMessageStream<ChatMessage>());
    },
  });

  return createUIMessageStreamResponse({
    stream,
  });
};

type HydrateMessagesProps = {
  messages: ChatMessage[];
  safeDb: SafeDb;
  userId: SafeId<"user">;
};

export const hydrateMessages = async ({
  messages,
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
