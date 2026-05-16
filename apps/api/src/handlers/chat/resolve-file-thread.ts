import { Result } from "better-result";
import { t } from "elysia";

import type { Transaction } from "@/api/db";
import { chatThreads, fileChatThreads } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
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

const createFileChatThread = async (
  tx: Transaction,
  {
    entityId,
    fieldId,
    organizationId,
    userId,
    workspaceId,
  }: FileThreadLookupInput,
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

  const chatThreadId = createSafeId<"chatThread">();

  await tx.insert(chatThreads).values({
    id: chatThreadId,
    organizationId,
    title: content.fileName,
    userId,
    workspaceId,
    contextMatterIds: [],
    dataWorkspaceIds: [workspaceId],
  });

  await tx.insert(fileChatThreads).values({
    id: createSafeId<"fileChatThread">(),
    organizationId,
    workspaceId,
    userId,
    entityId,
    fieldId,
    chatThreadId,
  });

  return {
    ok: true,
    chatThreadId,
  };
};

const resolveFileThread = createSafeHandler(
  config,
  async function* ({ body, safeDb, session, user, workspaceId }) {
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

      return await createFileChatThread(tx, input);
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
