import { isTextUIPart, safeValidateUIMessages } from "ai";
import type { ToolSet } from "ai";
import { panic, Result } from "better-result";
import type { Static } from "elysia";
import { t } from "elysia";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import type { SafeDb, SafeDbError } from "@/api/db";
import type { StoredFileRef } from "@/api/handlers/chat/attachment-validation";
import {
  validateChatFileParts,
  validateStoredFileRefs,
} from "@/api/handlers/chat/attachment-validation";
import { normalizeLegacyRawToolInputs } from "@/api/handlers/chat/legacy-tool-compat";
import type { ChatMention, ChatMessage } from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { normalizeChatMessageHtml } from "@/api/lib/markdown/chat-message";

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
  wordEditAuthorName: t.Optional(t.String()),
  wordEditShortcut: t.Optional(t.String()),
});

export const activeFileSchema = t.Object({
  entityId: tSafeId("entity"),
  fileName: t.String(),
  docxEditSnapshot: t.Optional(
    t.Object({
      canApplyEdits: t.Optional(t.Boolean()),
      blocks: t.Array(
        t.Object({
          id: t.String(),
          kind: t.Union([
            t.Literal("heading"),
            t.Literal("listItem"),
            t.Literal("paragraph"),
          ]),
          text: t.String(),
          displayLabel: t.Optional(t.String()),
        }),
      ),
    }),
  ),
});

export const activeDecisionSchema = t.Object({
  decisionId: tSafeId("caseLawDecision"),
});

export const activeExternalSchema = t.Object({
  connectorSlug: t.Optional(t.String()),
  provider: t.Optional(t.String()),
  snippet: t.Optional(t.String()),
  sourceToolName: t.Optional(t.String()),
  text: t.Optional(t.String()),
  title: t.String(),
  url: t.String(),
});

export const sendMessageBodySchema = t.Object({
  threadId: tSafeId("chatThread"),
  workspaceId: t.Optional(tSafeId("workspace")),
  sendMode: t.Union([
    t.Literal(CHAT_SEND_MODE.raw),
    t.Literal(CHAT_SEND_MODE.anonymized),
    t.Literal(CHAT_SEND_MODE.rawOverride),
  ]),
  /**
   * Matters the chat draws context from. Empty (or omitted) means
   * "no matters pinned" — the AI discovers matters lazily via the
   * readonly read API. Non-empty narrows tool authorization so
   * requested matterRefs must be a subset of this set. The set is
   * persisted on the chat thread so subsequent turns reuse it
   * without re-sending.
   */
  contextMatterIds: t.Optional(t.Array(tSafeId("workspace"))),
  message: rawMessageSchema,
  userContext: t.Optional(userContextSchema),
  activeFile: t.Optional(activeFileSchema),
  activeDecision: t.Optional(activeDecisionSchema),
  activeExternal: t.Optional(activeExternalSchema),
  devModelId: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 160,
      pattern: "^[A-Za-z0-9._:/-]+$",
    }),
  ),
});

type RawIncomingMessage = Static<typeof rawMessageSchema>;
export type IncomingUserContext = Static<typeof userContextSchema>;
export type IncomingActiveFile = Static<typeof activeFileSchema>;
export type IncomingActiveDecision = Static<typeof activeDecisionSchema>;
export type IncomingActiveExternal = Static<typeof activeExternalSchema>;

type ValidateMessageInput = {
  message: RawIncomingMessage;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  tools: ToolSet;
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
    const normalizedMessage = {
      ...message,
      parts: normalizeLegacyRawToolInputs(message.parts),
    };
    const validationResult = await safeValidateUIMessages<ChatMessage>({
      messages: [normalizedMessage],
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
