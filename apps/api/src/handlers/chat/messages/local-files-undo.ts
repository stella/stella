import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import type {
  ChatLocalFilesUndoAnswer,
  ChatLocalFilesUndoRead,
} from "@stll/api-contract/chat-local-files-undo";

import type { SafeDb } from "@/api/db/safe-db-types";
import { chatMessages, chatThreads } from "@/api/db/schema";
import {
  type ChatWorkspaceAccess,
  hasChatWorkspaceAccess,
} from "@/api/handlers/chat/chat-scope";
import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import { getDesktopRunnerControl } from "@/api/lib/desktop-runner/runtime";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const params = v.object({
  threadId: resourceIdSchema("chatThread"),
  messageId: resourceIdSchema("chatMessage"),
});

const messageNotFound = () =>
  new HandlerError({
    status: 404,
    code: "not_found",
    message: "Chat message not found",
  });

/** The undo is queued, or was asked before and is still going or done. */
const UNDO_ACCEPTED_STATUS = 202;
/** The changes cannot be undone now; the body says why. */
const UNDO_REFUSED_STATUS = 409;

type UndoDependencies = {
  control: () => Pick<
    DesktopRunnerControl,
    "readFolderRestore" | "requestFolderRestore"
  >;
};

/** This process's runner control, unless a test hands its own. */
const controlOf = (dependencies: UndoDependencies | undefined) =>
  dependencies?.control() ?? getDesktopRunnerControl().control;

type MessageOf = {
  safeDb: SafeDb;
  owner: { userId: SafeId<"user">; organizationId: SafeId<"organization"> };
  threadId: SafeId<"chatThread">;
  messageId: SafeId<"chatMessage">;
};

/**
 * The member's own message as their scope sees it, with the matters its
 * thread is scoped to and holds data of: chat RLS hides a message whose
 * matter the member can no longer open. `null` for a message the member
 * cannot see, or one that is not theirs to edit.
 */
const readVisibleMessage = async ({
  safeDb,
  owner,
  threadId,
  messageId,
}: MessageOf) =>
  await safeDb(async (tx) => {
    const [message] = await tx
      .select({
        workspaceId: chatThreads.workspaceId,
        dataWorkspaceIds: chatThreads.dataWorkspaceIds,
      })
      .from(chatMessages)
      .innerJoin(
        chatThreads,
        and(
          eq(chatThreads.id, chatMessages.threadId),
          eq(chatThreads.organizationId, owner.organizationId),
          eq(chatThreads.userId, owner.userId),
        ),
      )
      .where(
        and(
          eq(chatMessages.id, messageId),
          eq(chatMessages.threadId, threadId),
          eq(chatMessages.role, "user"),
        ),
      )
      .limit(1);
    return message ?? null;
  });

type WritableOptions = {
  message: {
    workspaceId: SafeId<"workspace"> | null;
    dataWorkspaceIds: readonly SafeId<"workspace">[];
  };
  getWorkspaceAccess: ChatWorkspaceAccess;
};

/** Whether the member may still change every matter the thread touches. */
const mattersWritable = async ({
  message,
  getWorkspaceAccess,
}: WritableOptions) =>
  (
    await Promise.all(
      [...new Set([message.workspaceId, ...message.dataWorkspaceIds])].map(
        async (workspaceId: SafeId<"workspace"> | null) =>
          await hasChatWorkspaceAccess({
            admitted: "active",
            workspaceId,
            getWorkspaceAccess,
          }),
      ),
    )
  ).every(Boolean);

const readConfig = {
  contract: "patch",
  description:
    "What editing your chat from one of your messages does on your " +
    "computer: whether the file changes made there since the message can be " +
    "undone (none, available, or unavailable with a reason), whether the " +
    "agent continues its session or starts over from the chat's text, and " +
    "the undo as it stands: queued, sent, restored, refused (with the " +
    "computer's reason) or expired. A message you cannot see is a 404.",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params,
} satisfies HandlerConfig;

/** What an edit from the message does on the computer, and its undo. */
export const createReadLocalFilesUndo = (dependencies?: UndoDependencies) =>
  createSafeRootHandler(
    readConfig,
    async function* ({
      params: { threadId, messageId },
      safeDb,
      session,
      user,
    }) {
      const owner = {
        userId: user.id,
        organizationId: session.activeOrganizationId,
      };
      const visible = yield* Result.await(
        readVisibleMessage({ safeDb, owner, threadId, messageId }),
      );
      if (visible === null) {
        return Result.err(messageNotFound());
      }
      const read = yield* Result.await(
        controlOf(dependencies).readFolderRestore({
          owner,
          threadId,
          messageId,
        }),
      );
      if (read === null) {
        return Result.err(messageNotFound());
      }
      const body: ChatLocalFilesUndoRead = {
        files: read.files,
        conversation: read.conversation,
        undo: read.restore,
      };
      return Result.ok(body);
    },
  );

/** What an undo request answers; one type for every branch, so the route infers the union. */
type UndoAnswer = ChatLocalFilesUndoAnswer;
const answer = (body: UndoAnswer) => Result.ok(body);

const undoConfig = {
  contract: "patch",
  description:
    "Undo the file changes made on your computer since one of your messages, " +
    "before editing the chat from it: the chat's folder goes back to how it " +
    "was before the message's turn, which undoes that turn and every later " +
    "one. Idempotent: asking again answers the undo that is queued, sent or " +
    "done. 202 with the undo; 409 with a reason when a turn still runs, no " +
    "saved copy of the folder from then is kept, later turns worked on " +
    "another computer or folder, another chat worked in the same folder, an " +
    "earlier undo already took the changes away, the computer is offline, or " +
    "its desktop app is too old to undo; a message you cannot see is a 404.",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params,
  aggregateMutation: {
    type: "independent",
    reason:
      "Queues one undo of the caller's own changes in the desktop runner store, which takes the caller's runner capacity lock inside its own transaction, as the runner's other writes do; no chat aggregate is written.",
  },
} satisfies HandlerConfig;

/** Ask the computer to undo the file changes made since the message. */
export const createUndoLocalFiles = (dependencies?: UndoDependencies) =>
  createSafeRootHandler(
    undoConfig,
    async function* ({
      getWorkspaceAccess,
      params: { threadId, messageId },
      recordAuditEvent,
      safeDb,
      session,
      set,
      user,
    }) {
      const owner = {
        userId: user.id,
        organizationId: session.activeOrganizationId,
      };
      const visible = yield* Result.await(
        readVisibleMessage({ safeDb, owner, threadId, messageId }),
      );
      // Changing the folder writes to the thread's matters: an archived matter
      // or one the member left refuses it like any write to it.
      if (visible === null) {
        return Result.err(messageNotFound());
      }
      const writable = yield* Result.await(
        Result.tryPromise(
          async () =>
            await mattersWritable({ message: visible, getWorkspaceAccess }),
        ),
      );
      if (!writable) {
        return Result.err(messageNotFound());
      }
      const outcome = yield* Result.await(
        controlOf(dependencies).requestFolderRestore({
          owner,
          threadId,
          messageId,
        }),
      );
      switch (outcome.type) {
        case "accepted": {
          if (outcome.restore.state === "queued") {
            yield* Result.await(
              safeDb(async (tx) => {
                await recordAuditEvent(tx, {
                  action: AUDIT_ACTION.UPDATE,
                  resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
                  resourceId: threadId,
                  metadata: {
                    reason: "undo_local_files",
                    messageId,
                    undoId: outcome.restore.restoreId,
                  },
                });
              }),
            );
          }
          set.status = UNDO_ACCEPTED_STATUS;
          return answer({
            status: "accepted",
            undo: outcome.restore,
            reason: null,
          });
        }
        case "refused":
          if (outcome.reason === "not_found") {
            return Result.err(messageNotFound());
          }
          set.status = UNDO_REFUSED_STATUS;
          return answer({
            status: "refused",
            undo: null,
            reason: outcome.reason,
          });
        default:
          outcome satisfies never;
          return panic("Unknown local files undo outcome");
      }
    },
  );

export const readLocalFilesUndo = createReadLocalFilesUndo();
export const undoLocalFiles = createUndoLocalFiles();
