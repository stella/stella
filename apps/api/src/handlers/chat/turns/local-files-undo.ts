import { panic, Result } from "better-result";
import * as v from "valibot";

import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import type {
  FolderRestoreRefusal,
  FolderRestoreView,
} from "@/api/lib/desktop-runner/folder-restores";
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
export const createReadLocalFilesUndo = (dependencies?: UndoDependencies) =>
  createSafeRootHandler(
    readConfig,
    async function* ({ params: { threadId, turnId }, session, user }) {
      const read = yield* Result.await(
        controlOf(dependencies).readFolderRestore({
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

/** What an undo request answers; one type for every branch, so the route infers the union. */
type UndoAnswer =
  | { status: "accepted"; undo: FolderRestoreView; reason: null }
  | {
      status: "refused";
      undo: null;
      reason: Exclude<FolderRestoreRefusal, "not_found">;
    };
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
      params: { threadId, turnId },
      recordAuditEvent,
      safeDb,
      session,
      set,
      user,
    }) {
      const outcome = yield* Result.await(
        controlOf(dependencies).requestFolderRestore({
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
