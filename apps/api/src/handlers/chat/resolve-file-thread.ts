import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import type { Transaction } from "@/api/db";
import { chatThreads, fileChatThreads } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";

const resolveFileThreadBodySchema = t.Object({
  entityId: tSafeId("entity"),
  fieldId: tSafeId("field"),
});

const config = {
  permissions: { chat: ["create"] },
  body: resolveFileThreadBodySchema,
} satisfies HandlerConfig;

const CHAT_THREAD_TITLE_MAX_LENGTH = 255;

type FileThreadLookupInput = {
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

type ResolveFileThreadTxResult =
  | {
      ok: true;
      chatThreadId: SafeId<"chatThread">;
    }
  | {
      ok: false;
      message: string;
      status: 404;
    };

const findFileChatThread = async (
  tx: Transaction,
  {
    entityId,
    fieldId,
    organizationId,
    userId,
    workspaceId,
  }: FileThreadLookupInput,
) =>
  await tx.query.fileChatThreads.findFirst({
    where: {
      entityId: { eq: entityId },
      fieldId: { eq: fieldId },
      organizationId: { eq: organizationId },
      userId: { eq: userId },
      workspaceId: { eq: workspaceId },
    },
    columns: {
      chatThreadId: true,
    },
  });

const findFieldKeyedChatThread = async (
  tx: Transaction,
  { fieldId, organizationId, userId, workspaceId }: FileThreadLookupInput,
) =>
  (
    await tx
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          // File chat threads were previously keyed directly by
          // field UUID. Preserve those rows without constructing
          // a new branded ID from request input.
          sql`${chatThreads.id} = ${fieldId}`,
          eq(chatThreads.organizationId, organizationId),
          eq(chatThreads.userId, userId),
          eq(chatThreads.workspaceId, workspaceId),
        ),
      )
      .limit(1)
  ).at(0);

const insertFileChatThread = async (
  tx: Transaction,
  {
    entityId,
    fieldId,
    organizationId,
    userId,
    workspaceId,
  }: FileThreadLookupInput,
  chatThreadId: SafeId<"chatThread">,
  recordAuditEvent: AuditRecorder,
) => {
  const fileChatThreadId = createSafeId<"fileChatThread">();
  await tx.insert(fileChatThreads).values({
    id: fileChatThreadId,
    organizationId,
    workspaceId,
    userId,
    entityId,
    fieldId,
    chatThreadId,
  });
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
    resourceId: chatThreadId,
    workspaceId,
    metadata: { entityId, fieldId, fileChatThreadId },
  });
};

const createFileChatThread = async (
  tx: Transaction,
  {
    entityId,
    fieldId,
    organizationId,
    userId,
    workspaceId,
  }: FileThreadLookupInput,
  recordAuditEvent: AuditRecorder,
): Promise<ResolveFileThreadTxResult> => {
  const entity = await tx.query.entities.findFirst({
    where: {
      id: { eq: entityId },
      workspaceId: { eq: workspaceId },
    },
    columns: {
      id: true,
    },
    with: {
      currentVersion: {
        columns: {},
        with: {
          fields: {
            columns: {
              content: true,
              id: true,
            },
          },
        },
      },
    },
  });

  const field = entity?.currentVersion?.fields.find(
    (candidate) => candidate.id === fieldId,
  );
  const content = field?.content;

  if (content?.type !== "file") {
    return {
      ok: false,
      status: 404,
      message: "File not found",
    };
  }

  const fieldKeyedThread = await findFieldKeyedChatThread(tx, {
    entityId,
    fieldId,
    organizationId,
    userId,
    workspaceId,
  });

  if (fieldKeyedThread) {
    await insertFileChatThread(
      tx,
      {
        entityId,
        fieldId,
        organizationId,
        userId,
        workspaceId,
      },
      fieldKeyedThread.id,
      recordAuditEvent,
    );

    return {
      ok: true,
      chatThreadId: fieldKeyedThread.id,
    };
  }

  const chatThreadId = createSafeId<"chatThread">();

  await tx.insert(chatThreads).values({
    id: chatThreadId,
    organizationId,
    title: content.fileName.slice(0, CHAT_THREAD_TITLE_MAX_LENGTH),
    userId,
    workspaceId,
    contextMatterIds: [],
    dataWorkspaceIds: [workspaceId],
  });

  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.CREATE,
    resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
    resourceId: chatThreadId,
    workspaceId,
    metadata: { entityId, fieldId, source: "resolve-file-thread" },
  });

  await insertFileChatThread(
    tx,
    {
      entityId,
      fieldId,
      organizationId,
      userId,
      workspaceId,
    },
    chatThreadId,
    recordAuditEvent,
  );

  return {
    ok: true,
    chatThreadId,
  };
};

const resolveFileThread = createSafeHandler(
  config,
  async function* ({
    body,
    recordAuditEvent,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    const input: FileThreadLookupInput = {
      entityId: body.entityId,
      fieldId: body.fieldId,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      workspaceId,
    };

    const txResult = await safeDb(async (tx) => {
      const existing = await findFileChatThread(tx, input);

      if (existing) {
        return {
          ok: true as const,
          chatThreadId: existing.chatThreadId,
        };
      }

      return await createFileChatThread(tx, input, recordAuditEvent);
    });

    if (Result.isError(txResult)) {
      if (
        !DatabaseError.is(txResult.error) ||
        txResult.error.code !== PG_ERROR.UNIQUE_VIOLATION
      ) {
        return yield* Result.err(txResult.error);
      }

      const recovered = yield* Result.await(
        safeDb(async (tx) => await findFileChatThread(tx, input)),
      );

      if (recovered) {
        return Result.ok({ threadId: recovered.chatThreadId });
      }

      return yield* Result.err(
        new HandlerError({
          status: 404,
          message: "File not found",
        }),
      );
    }

    if (!txResult.value.ok) {
      return yield* Result.err(
        new HandlerError({
          status: txResult.value.status,
          message: txResult.value.message,
        }),
      );
    }

    return Result.ok({ threadId: txResult.value.chatThreadId });
  },
);

export default resolveFileThread;
