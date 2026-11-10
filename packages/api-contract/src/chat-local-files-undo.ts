import * as v from "valibot";

import {
  DESKTOP_RUNNER_FOLDER_RESTORE_REFUSALS,
  type DesktopRunnerFolderRestoreRefusal,
} from "./desktop-runner";

/**
 * Undoing the file changes a chat turn made on the member's computer:
 * `GET` and `POST /chat/threads/:threadId/turns/:turnId/local-files/undo`.
 */

/**
 * Where an undo stands: waiting for the computer's socket (`queued`), sent
 * and not answered (`sent`), done (`restored`), refused by the computer
 * (`refused`, with its reason), or never sent in time (`expired`).
 */
export const CHAT_LOCAL_FILES_UNDO_STATES = [
  "queued",
  "sent",
  "restored",
  "refused",
  "expired",
] as const;
export type ChatLocalFilesUndoState =
  (typeof CHAT_LOCAL_FILES_UNDO_STATES)[number];

/** States in which a turn's undo counts: a turn has at most one. */
export const CHAT_LOCAL_FILES_UNDO_LIVE_STATES = [
  "queued",
  "sent",
  "restored",
] as const satisfies readonly ChatLocalFilesUndoState[];

/** States an undo ends in. */
export const CHAT_LOCAL_FILES_UNDO_SETTLED_STATES = [
  "restored",
  "refused",
  "expired",
] as const satisfies readonly ChatLocalFilesUndoState[];

/** Why the computer refused an undo; the runner protocol's own words. */
export const CHAT_LOCAL_FILES_UNDO_COMPUTER_REFUSALS =
  DESKTOP_RUNNER_FOLDER_RESTORE_REFUSALS;
export type ChatLocalFilesUndoComputerRefusal =
  DesktopRunnerFolderRestoreRefusal;

/**
 * Why the API refused to ask for an undo (409): a later turn exists, a turn
 * or run of the thread is still going, the turn's run saved no checkpoint,
 * the run's computer is offline, or it runs a desktop app too old to undo.
 */
export const CHAT_LOCAL_FILES_UNDO_REFUSALS = [
  "not_newest",
  "thread_busy",
  "no_checkpoint",
  "desktop_offline",
  "desktop_update_required",
] as const;
export type ChatLocalFilesUndoRefusal =
  (typeof CHAT_LOCAL_FILES_UNDO_REFUSALS)[number];

/** A turn's undo as the member sees it. */
export const chatLocalFilesUndoSchema = v.object({
  restoreId: v.pipe(v.string(), v.uuid()),
  state: v.picklist(CHAT_LOCAL_FILES_UNDO_STATES),
  reason: v.nullable(v.picklist(CHAT_LOCAL_FILES_UNDO_COMPUTER_REFUSALS)),
});
export type ChatLocalFilesUndo = v.InferOutput<typeof chatLocalFilesUndoSchema>;

/** `GET`: whether the turn can be undone, and its undo, if one was asked. */
export const chatLocalFilesUndoReadSchema = v.object({
  undoable: v.boolean(),
  undo: v.nullable(chatLocalFilesUndoSchema),
});
export type ChatLocalFilesUndoRead = v.InferOutput<
  typeof chatLocalFilesUndoReadSchema
>;

/** `POST`: 202 with the undo, or 409 with why it was not asked. */
export const chatLocalFilesUndoAnswerSchema = v.variant("status", [
  v.object({
    status: v.literal("accepted"),
    undo: chatLocalFilesUndoSchema,
    reason: v.null(),
  }),
  v.object({
    status: v.literal("refused"),
    undo: v.null(),
    reason: v.picklist(CHAT_LOCAL_FILES_UNDO_REFUSALS),
  }),
]);
export type ChatLocalFilesUndoAnswer = v.InferOutput<
  typeof chatLocalFilesUndoAnswerSchema
>;
