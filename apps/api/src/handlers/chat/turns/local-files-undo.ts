import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import type {
  ChatLocalFilesUndoAnswer,
  ChatLocalFilesUndoRead,
} from "@stll/api-contract/chat-local-files-undo";

import type { SafeDb } from "@/api/db/safe-db";
import { chatThreads, chatTurns } from "@/api/db/schema";
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
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import { getDesktopRunnerControl } from "@/api/lib/desktop-runner/runtime";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const params = v.object({
  threadId: resourceIdSchema("chatThread"),
  turnId: resourceIdSchema("chatTurn"),
});

const turnNotFound = () =>
  new HandlerError({
    status: 404,
    code: "not_found",
    message: "Chat turn not found",
  });

/** The undo is queued, or was asked before and is still going or done. */
const UNDO_ACCEPTED_STATUS = 202;
/** The turn cannot be undone now; the body says why. */
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

type TurnOf = {
  safeDb: SafeDb;
  owner: { userId: SafeId<"user">; organizationId: SafeId<"organization"> };
  threadId: SafeId<"chatThread">;
  turnId: SafeId<"chatTurn">;
};

/**
 * The turn as the member's own scope sees it, with the matters its thread is
 * scoped to and holds data of: chat RLS hides a turn whose matter the member
 * can no longer open. `null` for a turn the member cannot see.
 */
const readVisibleTurn = async ({ safeDb, owner, threadId, turnId }: TurnOf) =>
  await safeDb(async (tx) => {
    const [turn] = await tx
      .select({
        workspaceId: chatThreads.workspaceId,
        dataWorkspaceIds: chatThreads.dataWorkspaceIds,
      })
      .from(chatTurns)
      .innerJoin(
        chatThreads,
        and(
          eq(chatThreads.id, chatTurns.threadId),
          eq(chatThreads.organizationId, owner.organizationId),
          eq(chatThreads.userId, owner.userId),
        ),
      )
      .where(
        and(
          eq(chatTurns.id, turnId),
          eq(chatTurns.threadId, threadId),
          eq(chatTurns.organizationId, owner.organizationId),
        ),
      )
      .limit(1);
    return turn ?? null;
  });

type WritableOptions = {
  turn: {
    workspaceId: SafeId<"workspace"> | null;
    dataWorkspaceIds: readonly SafeId<"workspace">[];
  };
  getWorkspaceAccess: ChatWorkspaceAccess;
};

/** Whether the member may still change every matter the thread touches. */
const mattersWritable = async ({ turn, getWorkspaceAccess }: WritableOptions) =>
  (
    await Promise.all(
      [...new Set([turn.workspaceId, ...turn.dataWorkspaceIds])].map(
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
    "Whether the file changes a turn made on your computer can be undone, " +
    "and the turn's undo as it stands: queued, sent, restored, refused (with " +
    "the computer's reason) or expired. A turn you cannot see is a 404.",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params,
} satisfies HandlerConfig;

/** Where the undo of a turn's file changes stands. */
export const createReadLocalFilesUndo = (dependencies?: UndoDependencies) =>
  createSafeRootHandler(
    readConfig,
    async function* ({ params: { threadId, turnId }, safeDb, session, user }) {
      const owner = {
        userId: user.id,
        organizationId: session.activeOrganizationId,
      };
      const visible = yield* Result.await(
        readVisibleTurn({ safeDb, owner, threadId, turnId }),
      );
      if (visible === null) {
        return Result.err(turnNotFound());
      }
      const read = yield* Result.await(
        controlOf(dependencies).readFolderRestore({ owner, threadId, turnId }),
      );
      if (read === null) {
        return Result.err(turnNotFound());
      }
      const body: ChatLocalFilesUndoRead = {
        undoable: read.undoable,
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
    "Undo the file changes the newest turn of your chat thread made on your " +
    "computer: its folder goes back to how it was before the turn. Idempotent " +
    "per turn: asking again answers the undo that is queued, sent or done. " +
    "202 with the undo; 409 with a reason when the turn is not the newest, a " +
    "turn still runs, there is nothing to undo, or the computer is offline; " +
    "a turn you cannot see is a 404.",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params,
} satisfies HandlerConfig;

/** Ask the turn's computer to undo the turn's file changes. */
export const createUndoLocalFiles = (dependencies?: UndoDependencies) =>
  createSafeRootHandler(
    undoConfig,
    async function* ({
      getWorkspaceAccess,
      params: { threadId, turnId },
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
        readVisibleTurn({ safeDb, owner, threadId, turnId }),
      );
      // Changing the folder writes to the thread's matters: an archived matter
      // or one the member left refuses it like any write to it.
      if (visible === null) {
        return Result.err(turnNotFound());
      }
      const writable = yield* Result.await(
        Result.tryPromise(
          async () =>
            await mattersWritable({ turn: visible, getWorkspaceAccess }),
        ),
      );
      if (!writable) {
        return Result.err(turnNotFound());
      }
      const outcome = yield* Result.await(
        controlOf(dependencies).requestFolderRestore({
          owner,
          threadId,
          turnId,
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
                    turnId,
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
            return Result.err(turnNotFound());
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

declareAggregateMutation(undoLocalFiles, {
  type: "independent",
  reason:
    "Queues one undo of the caller's own turn in the desktop runner store, which takes the caller's runner capacity lock inside its own transaction, as the runner's other writes do; no chat aggregate is written.",
});
