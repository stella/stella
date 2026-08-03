import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { t } from "elysia";

import {
  chatMessages,
  entities,
  entityVersions,
  fields,
} from "@/api/db/schema";
import {
  chatMessageContentFromMessage,
  chatMessageFromPersisted,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import type { CreateDocumentToolOutput } from "@/api/handlers/chat/tools/create-document-tool";
import type {
  ChatMessage,
  PersistableChatMessage,
} from "@/api/handlers/chat/types";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type CreatedDraftOutput = Extract<
  CreateDocumentToolOutput,
  { entityId: string; success: true }
>;

const isMatchingSavedOutput = (
  value: unknown,
  output: CreatedDraftOutput,
): boolean =>
  typeof value === "object" &&
  value !== null &&
  "success" in value &&
  value.success === true &&
  "entityId" in value &&
  value.entityId === output.entityId &&
  "fieldId" in value &&
  value.fieldId === output.fieldId &&
  "workspaceId" in value &&
  value.workspaceId === output.workspaceId;

const isReplaceableCreateDocumentOutput = (
  candidate: CreateDocumentToolOutput | undefined,
  output: CreatedDraftOutput,
): boolean =>
  candidate !== undefined &&
  (("destination" in candidate && candidate.destination === "draft") ||
    isMatchingSavedOutput(candidate, output));

export const hasMatchingCreatedDraftOutput = ({
  message,
  output,
  toolCallId,
}: {
  message: ChatMessage;
  output: CreatedDraftOutput;
  toolCallId: string;
}): boolean =>
  message.parts.some(
    (part) =>
      part.type === "tool-call" &&
      part.id === toolCallId &&
      part.name === "create-document" &&
      part.state === "complete" &&
      isMatchingSavedOutput(part.output, output),
  );

export const replaceCreatedDraftOutput = ({
  message,
  messageId,
  output,
  toolCallId,
}: {
  message: ChatMessage;
  messageId: SafeId<"chatMessage">;
  output: CreatedDraftOutput;
  toolCallId: string;
}): PersistableChatMessage | null => {
  const hasToolCall = message.parts.some(
    (part) =>
      part.type === "tool-call" &&
      part.id === toolCallId &&
      part.name === "create-document" &&
      part.state === "complete" &&
      isReplaceableCreateDocumentOutput(part.output, output),
  );
  if (!hasToolCall) {
    return null;
  }
  const parts = message.parts.map((part) => {
    if (
      part.type === "tool-call" &&
      part.id === toolCallId &&
      part.name === "create-document" &&
      part.state === "complete" &&
      isReplaceableCreateDocumentOutput(part.output, output)
    ) {
      return { ...part, output };
    }
    if (part.type === "tool-result" && part.toolCallId === toolCallId) {
      return {
        ...part,
        content: JSON.stringify(output),
        state: "complete" as const,
      };
    }
    return part;
  });
  return toPersistableChatMessage({
    ...message,
    id: messageId,
    parts,
  });
};

const config = {
  access: "write",
  permissions: { chat: ["update"] },
  mcp: { type: "internal", reason: "assistant_chat" },
  params: t.Object({ threadId: tSafeId("chatThread") }),
  query: t.Object({
    workspaceId: t.Optional(tSafeId("workspace")),
  }),
  body: t.Object({
    destinationWorkspaceId: tSafeId("workspace"),
    entityId: tSafeId("entity"),
    fieldId: tSafeId("field"),
    messageId: tSafeId("chatMessage"),
    toolCallId: t.String(),
  }),
} satisfies HandlerConfig;

const saveCreatedDraft = createSafeRootHandler(
  config,
  async function* ({
    body,
    getWorkspaceAccess,
    params: { threadId },
    query: { workspaceId },
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const threadScope = yield* resolveChatScope({
      getWorkspaceAccess,
      workspaceId,
    });
    yield* resolveChatScope({
      getWorkspaceAccess,
      workspaceId: body.destinationWorkspaceId,
    });

    const persisted = yield* Result.await(
      safeDb(async (tx) => {
        const thread = await tx.query.chatThreads.findFirst({
          where: {
            id: { eq: threadId },
            organizationId: { eq: session.activeOrganizationId },
            userId: { eq: user.id },
          },
          columns: { id: true, workspaceId: true },
        });
        const expectedThreadWorkspaceId =
          threadScope.scope === "workspace" ? threadScope.workspaceId : null;
        if (thread?.workspaceId !== expectedThreadWorkspaceId) {
          return { status: "missing-thread" } as const;
        }

        const [message] = await tx
          .select({
            content: chatMessages.content,
            id: chatMessages.id,
            role: chatMessages.role,
          })
          .from(chatMessages)
          .where(
            and(
              eq(chatMessages.id, body.messageId),
              eq(chatMessages.threadId, threadId),
              eq(chatMessages.userId, user.id),
              expectedThreadWorkspaceId === null
                ? isNull(chatMessages.workspaceId)
                : eq(chatMessages.workspaceId, expectedThreadWorkspaceId),
            ),
          )
          .limit(1)
          .for("update");
        if (!message || message.role !== "assistant") {
          return { status: "missing-message" } as const;
        }

        const [field] = await tx
          .select({ content: fields.content })
          .from(entities)
          .innerJoin(
            entityVersions,
            and(
              eq(entityVersions.id, entities.currentVersionId),
              eq(entityVersions.entityId, entities.id),
              eq(entityVersions.workspaceId, entities.workspaceId),
              isNull(entityVersions.deletedAt),
            ),
          )
          .innerJoin(
            fields,
            and(
              eq(fields.id, body.fieldId),
              eq(fields.entityVersionId, entityVersions.id),
              eq(fields.workspaceId, entities.workspaceId),
            ),
          )
          .where(
            and(
              eq(entities.id, body.entityId),
              eq(entities.workspaceId, body.destinationWorkspaceId),
            ),
          )
          .limit(1);
        if (field?.content.type !== "file") {
          return { status: "missing-document" } as const;
        }

        const href = `#stella-entity=${body.destinationWorkspaceId}:${body.entityId}`;
        const output: CreatedDraftOutput = {
          success: true,
          entityId: body.entityId,
          entityRef: body.entityId,
          fieldId: body.fieldId,
          fileName: field.content.fileName,
          href,
          matterRef: body.destinationWorkspaceId,
          mention: `[${field.content.fileName}](${href})`,
          workspaceId: body.destinationWorkspaceId,
        };
        const parsedMessage = chatMessageFromPersisted(message);
        if (
          hasMatchingCreatedDraftOutput({
            message: parsedMessage,
            output,
            toolCallId: body.toolCallId,
          })
        ) {
          return { status: "saved", output } as const;
        }
        const updated = replaceCreatedDraftOutput({
          message: parsedMessage,
          messageId: message.id,
          output,
          toolCallId: body.toolCallId,
        });
        if (updated === null) {
          return { status: "not-draft" } as const;
        }

        await tx
          .update(chatMessages)
          .set({ content: chatMessageContentFromMessage(updated) })
          .where(eq(chatMessages.id, message.id));
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
          resourceId: message.id,
          workspaceId: expectedThreadWorkspaceId,
          changes: {
            createDocumentDestination: {
              old: "draft",
              new: "matter",
            },
          },
        });
        return { status: "saved", output } as const;
      }),
    );

    if (persisted.status !== "saved") {
      return Result.err(
        new HandlerError({
          status: persisted.status === "not-draft" ? 409 : 404,
          message: "Generated draft save state could not be persisted",
        }),
      );
    }
    return Result.ok(persisted.output);
  },
);

export default saveCreatedDraft;
