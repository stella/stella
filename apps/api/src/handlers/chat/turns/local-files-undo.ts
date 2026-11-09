import { panic, Result } from "better-result";
import * as v from "valibot";

import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema } from "@/api/lib/custom-schema";
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

const readConfig = {
  contract: "patch",
  description:
    "Whether the file changes a turn made on your computer can be undone, " +
    "and the turn's undo as it stands: queued, sent, restored, refused (with " +
    "the computer's reason) or expired. A turn you cannot see is a 404.",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params,
} satisfies HandlerConfig;

/** Where the undo of a turn's file changes stands. */
export const readLocalFilesUndo = createSafeRootHandler(
  readConfig,
  async function* ({ params: { threadId, turnId }, session, user }) {
    const read = yield* Result.await(
      getDesktopRunnerControl().control.readFolderRestore({
        owner: {
          userId: user.id,
          organizationId: session.activeOrganizationId,
        },
        threadId,
        turnId,
      }),
    );
    if (read === null) {
      return Result.err(turnNotFound());
    }
    return Result.ok({ undoable: read.undoable, undo: read.restore });
  },
);

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
export const undoLocalFiles = createSafeRootHandler(
  undoConfig,
  async function* ({
    params: { threadId, turnId },
    recordAuditEvent,
    safeDb,
    session,
    set,
    user,
  }) {
    const outcome = yield* Result.await(
      getDesktopRunnerControl().control.requestFolderRestore({
        owner: {
          userId: user.id,
          organizationId: session.activeOrganizationId,
        },
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
        return Result.ok({
          status: "accepted" as const,
          undo: outcome.restore,
          reason: null,
        });
      }
      case "refused":
        if (outcome.reason === "not_found") {
          return Result.err(turnNotFound());
        }
        set.status = UNDO_REFUSED_STATUS;
        return Result.ok({
          status: "refused" as const,
          undo: null,
          reason: outcome.reason,
        });
      default:
        outcome satisfies never;
        return panic("Unknown local files undo outcome");
    }
  },
);
