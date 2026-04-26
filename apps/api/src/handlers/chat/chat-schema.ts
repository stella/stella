import { isTextUIPart, safeValidateUIMessages } from "ai";
import { panic, Result } from "better-result";
import type { Static } from "elysia";
import { t } from "elysia";

import type { SafeDb, SafeDbError } from "@/api/db";
import type { StoredFileRef } from "@/api/handlers/chat/attachment-validation";
import {
  validateChatFileParts,
  validateStoredFileRefs,
} from "@/api/handlers/chat/attachment-validation";
import type { ChatMention, ChatMessage } from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { normalizeChatMessageHtml } from "@/api/lib/markdown/chat-message";

import type { ChatTools } from "./tools/chat-tools";

const rawMessageSchema = t.Object(
  {
    id: tSafeId("chatMessage"),
    role: t.Union([
      t.Literal("system"),
      t.Literal("user"),
      t.Literal("assistant"),
    ]),
    parts: t.Array(t.Any()),
  },
  { additionalProperties: true },
);

export const userContextSchema = t.Object({
  userName: t.String(),
  locale: t.String(),
  timezone: t.String(),
});

export const activeFileSchema = t.Object({
  entityId: tSafeId("entity"),
  fileName: t.String(),
});

export const sendMessageBodySchema = t.Object({
  threadId: tSafeId("chatThread"),
  workspaceId: t.Optional(tSafeId("workspace")),
  message: rawMessageSchema,
  userContext: t.Optional(userContextSchema),
  activeFile: t.Optional(activeFileSchema),
});

type RawIncomingMessage = Static<typeof rawMessageSchema>;
export type IncomingUserContext = Static<typeof userContextSchema>;
export type IncomingActiveFile = Static<typeof activeFileSchema>;

type ValidateMessageInput = {
  message: RawIncomingMessage;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  tools: ChatTools;
  userId: SafeId<"user">;
};

type ValidateMessageResult = Result<
  {
    message: ChatMessage;
    storedFileRefs: StoredFileRef[];
  },
  HandlerError<400 | 403 | 404> | SafeDbError
>;

export const validateMessage = async ({
  message,
  safeDb,
  threadId,
  tools,
  userId,
}: ValidateMessageInput): Promise<ValidateMessageResult> =>
  await Result.gen(async function* () {
    const validationResult = await safeValidateUIMessages<ChatMessage>({
      messages: [message],
      tools,
    });

    if (!validationResult.success) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid chat message",
          cause: validationResult.error,
        }),
      );
    }

    const validatedMessage = validationResult.data.at(0);

    if (!validatedMessage) {
      panic("Validated incoming chat messages unexpectedly empty");
    }

    const storedFileRefsResult = validateChatFileParts({
      parts: validatedMessage.parts,
    });

    if (Result.isError(storedFileRefsResult)) {
      return Result.err(storedFileRefsResult.error);
    }

    const storedFileRefs = storedFileRefsResult.value;

    if (storedFileRefs.length === 0) {
      return Result.ok({
        message: validatedMessage,
        storedFileRefs,
      });
    }

    const files = yield* Result.await(
      safeDb((tx) =>
        tx.query.userFiles.findMany({
          where: {
            id: { in: storedFileRefs.map((ref) => ref.id) },
            userId: { eq: userId },
          },
          columns: {
            id: true,
            threadId: true,
            mimeType: true,
          },
        }),
      ),
    );

    const storedFileValidationResult = validateStoredFileRefs({
      refs: storedFileRefs,
      files,
      threadId,
    });

    if (Result.isError(storedFileValidationResult)) {
      return Result.err(storedFileValidationResult.error);
    }

    return Result.ok({
      message: validatedMessage,
      storedFileRefs,
    });
  });

type ParseMessageProps = {
  accessibleWorkspaceIds: SafeId<"workspace">[];
  message: ChatMessage;
};

type ParseMessageResult = {
  mentions: ChatMention[];
  message: ChatMessage;
};

export const parseMessage = ({
  accessibleWorkspaceIds,
  message,
}: ParseMessageProps): ParseMessageResult => {
  if (message.role !== "user") {
    return {
      message,
      mentions: [],
    };
  }

  const normalizedParts: ChatMessage["parts"] = [];
  const mentions: ChatMention[] = [];

  for (const part of message.parts) {
    if (isTextUIPart(part)) {
      const normalizedText = normalizeChatMessageHtml(
        part.text,
        accessibleWorkspaceIds,
      );

      mentions.push(...normalizedText.mentions);
      normalizedParts.push({
        ...part,
        text: normalizedText.text,
      });
      continue;
    }

    normalizedParts.push(part);
  }

  return {
    message: {
      ...message,
      parts: normalizedParts,
    },
    mentions,
  };
};
