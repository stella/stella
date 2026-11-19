import * as v from "valibot";

import { apiDateTimeSchema } from "./api-date";
import {
  DESKTOP_RUNNER_FOLDER_RESTORE_REFUSALS,
  type DesktopRunnerFolderRestoreRefusal,
} from "./desktop-runner";

/**
 * Undoing the file changes made on the member's computer since one of their
 * messages, as part of editing the chat from that message:
 * `GET` and `POST /chat/threads/:threadId/messages/:messageId/local-files/undo`.
 * The folder goes back to how it was before the message's turn, which undoes
 * that turn and every later one.
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

/** States in which an undo counts: a checkpoint is restored by at most one. */
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
 * Why the file changes since a message cannot be undone (the read's
 * `unavailable`, the request's 409): a turn or run of the thread is still
 * going; no saved copy of the folder from before the message's turn is kept;
 * later turns worked on another computer or in another folder; another chat
 * worked in the same linked folder since; an earlier undo already took these
 * changes away; the computer is offline, or runs a desktop app too old to
 * undo.
 */
export const CHAT_LOCAL_FILES_UNDO_REFUSALS = [
  "thread_busy",
  "no_checkpoint",
  "several_folders",
  "folder_shared",
  "already_undone",
  "desktop_offline",
  "desktop_update_required",
] as const;
export type ChatLocalFilesUndoRefusal =
  (typeof CHAT_LOCAL_FILES_UNDO_REFUSALS)[number];

/** An undo as the member sees it. */
export const chatLocalFilesUndoSchema = v.object({
  restoreId: v.pipe(v.string(), v.uuid()),
  state: v.picklist(CHAT_LOCAL_FILES_UNDO_STATES),
  reason: v.nullable(v.picklist(CHAT_LOCAL_FILES_UNDO_COMPUTER_REFUSALS)),
});
export type ChatLocalFilesUndo = v.InferOutput<typeof chatLocalFilesUndoSchema>;

/**
 * Whether files changed on a computer since the message can be undone:
 * `none` when no turn from the message on worked in a folder on a computer
 * (a cloud chat), so there is nothing to offer.
 */
export const chatLocalFilesUndoFilesSchema = v.variant("type", [
  v.object({ type: v.literal("none") }),
  v.object({ type: v.literal("available") }),
  v.object({
    type: v.literal("unavailable"),
    reason: v.picklist(CHAT_LOCAL_FILES_UNDO_REFUSALS),
  }),
]);

export type ChatLocalFilesUndoFiles = v.InferOutput<
  typeof chatLocalFilesUndoFilesSchema
>;

/**
 * How the agent on the computer goes on after an edit of the message:
 * `continues` its session as it stood at the answer before the message, or
 * `restarts` from the chat's text because that answer's turn did not finish
 * (an interrupted or failed turn is not a point a session continues from).
 */
export const chatLocalFilesUndoConversationSchema = v.variant("type", [
  v.object({ type: v.literal("continues") }),
  v.object({
    type: v.literal("restarts"),
    reason: v.literal("previous_not_finished"),
  }),
]);

export type ChatLocalFilesUndoConversation = v.InferOutput<
  typeof chatLocalFilesUndoConversationSchema
>;

/**
 * `GET`: what editing the chat from this message does on the member's
 * computer, and the undo of its file changes, if one was asked.
 */
export const chatLocalFilesUndoReadSchema = v.object({
  files: chatLocalFilesUndoFilesSchema,
  conversation: chatLocalFilesUndoConversationSchema,
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

/**
 * The marker an answer carries once its turn's file changes were undone, as
 * message metadata: written by the server, on every answer the restore
 * undid, in the same transaction that records the computer's answer, so it
 * stays with the answer after newer turns, a reload or a move to the cloud.
 * A client's metadata never sets it.
 */
export const CHAT_LOCAL_FILES_UNDONE_METADATA_KEY = "localFilesUndone";

export const chatLocalFilesUndoneSchema = v.strictObject({
  /** When the computer reported the files restored. */
  at: apiDateTimeSchema,
});
export type ChatLocalFilesUndone = v.InferOutput<
  typeof chatLocalFilesUndoneSchema
>;
