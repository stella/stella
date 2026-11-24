import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  CHAT_MESSAGE_EDIT_ERROR_CODE,
  type ChatMessageEditErrorCode,
} from "@stll/api-contract";
import { isChatPastedTextPart } from "@stll/api-contract/chat";
import {
  CHAT_LOCAL_FILES_UNDO_LIVE_STATES,
  CHAT_LOCAL_FILES_UNDO_SETTLED_STATES,
  type ChatLocalFilesUndo,
  chatLocalFilesUndoAnswerSchema,
  type ChatLocalFilesUndoComputerRefusal,
  type ChatLocalFilesUndoRead,
  chatLocalFilesUndoReadSchema,
  type ChatLocalFilesUndoRefusal,
  type ChatLocalFilesUndoState,
} from "@stll/api-contract/chat-local-files-undo";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";
import { sendRefusal } from "@/state/chat-attachments";
import type { SendRefusal } from "@/state/chat-attachments";
import { shownFileOf } from "@/state/chat-messages";
import type { ChatEntry, ShownFile } from "@/state/chat-messages";

/**
 * Editing one of the person's sent messages ("Edit from here"), as the web
 * does: the message goes back in place under the same id, which drops it and
 * every later message, and the model answers it again. In a chat that runs
 * on the person's computer the edit may first undo the file changes made
 * there since the message (`…/messages/:messageId/local-files/undo`). The
 * words are the web's, under `chat.edit` in the phone's catalogue.
 */

/** What a long press on a message offers. */
export type MessageAction = "edit";

/**
 * The actions a long press on `entry` offers: a stored message of the
 * person's can be edited. Its live copy, still being sent, and an answer
 * offer nothing.
 */
export const messageActions = (entry: ChatEntry): readonly MessageAction[] =>
  entry.role === "user" && entry.parts !== undefined ? ["edit"] : [];

/**
 * A file or pasted text the edited message carries on as it was stored:
 * its part, and the name and type its chip shows.
 */
type KeptAttachment = ShownFile & {
  readonly key: string;
  readonly part: unknown;
};

/** The edit form's starting state: the message's own text, and what rides along. */
export type EditDraft = {
  readonly text: string;
  readonly kept: readonly KeptAttachment[];
};

const textPartSchema = v.object({
  type: v.literal("text"),
  content: v.string(),
});

/** A pasted text's chip reads as its first line with words, as on the web. */
const pastedTitle = (content: string) =>
  content.split(/\r\n|\r|\n/u).find((line) => line.trim() !== "") ?? "";

/**
 * Splits a stored message into the text the person edits (its text parts,
 * one paragraph each, as the web reads them) and the files and pasted texts
 * it carries on unchanged unless removed.
 */
export const editDraftOf = (parts: readonly unknown[]): EditDraft => {
  const texts: string[] = [];
  const kept: KeptAttachment[] = [];
  for (const [index, part] of parts.entries()) {
    const key = String(index);
    if (isChatPastedTextPart(part)) {
      kept.push({
        key,
        name: pastedTitle(part.content),
        mimeType: "text/plain",
        part,
        unscannedContent: [],
      });
      continue;
    }
    const file = shownFileOf(part);
    if (file !== null) {
      kept.push({ ...file, key, part });
      continue;
    }
    const text = v.safeParse(textPartSchema, part);
    if (text.success && text.output.content.trim() !== "") {
      texts.push(text.output.content.trim());
    }
  }
  return { text: texts.join("\n\n"), kept };
};

/** Whether the edit would send anything: text or a kept attachment. */
export const hasEditContent = ({ text, kept }: EditDraft): boolean =>
  text.trim() !== "" || kept.length > 0;

/** The edited message's parts: its text first, then what it carries on. */
export const editedMessageParts = ({ text, kept }: EditDraft): unknown[] => [
  ...(text.trim() === "" ? [] : [{ type: "text", content: text.trim() }]),
  ...kept.map(({ part }) => part),
];

/**
 * The edited message as the thread shows it while its answer runs, until
 * the stored thread is read again: its text, and the names of what it
 * carries on.
 */
export const editedEntry = ({
  createdAt,
  draft,
  messageId,
}: {
  readonly createdAt: string;
  readonly draft: EditDraft;
  readonly messageId: string;
}): ChatEntry => ({
  id: messageId,
  role: "user",
  createdAt,
  text: draft.text.trim(),
  blocks: [],
  files: draft.kept.map(({ mimeType, name, unscannedContent }) => ({
    mimeType,
    name,
    unscannedContent,
  })),
  drafts: [],
  contextNotice: null,
});

/**
 * The loaded thread once the server took an edit of `messageId`: the
 * messages before it. The stored thread read after the answer then follows
 * them, and the replaced messages cannot come back as older ones.
 */
export const entriesBefore = (
  entries: readonly ChatEntry[],
  messageId: string,
): readonly ChatEntry[] => {
  const index = entries.findIndex(({ id }) => id === messageId);
  return index === -1 ? entries : entries.slice(0, index);
};

/**
 * What is shown of the loaded thread while an edit of `truncates` runs: the
 * messages before it. Without an edit running, all of them.
 */
export const shownBeforeEdit = (
  entries: readonly ChatEntry[],
  truncates: string | undefined,
): readonly ChatEntry[] =>
  truncates === undefined ? entries : entriesBefore(entries, truncates);

/**
 * The open edit form once the edit sent from form `session` was taken:
 * closed when it is still that form, kept when the member closed it and
 * opened another meanwhile.
 */
export const formAfterAccepted = <Form extends { readonly session: number }>(
  current: Form | null,
  session: number,
): Form | null => (current?.session === session ? null : current);

/** Why the server did not take an edit, as the form says it. */
type EditRefusal = "refused" | "history-changed" | "target-missing";

const EDIT_REFUSALS = {
  [CHAT_MESSAGE_EDIT_ERROR_CODE.historyChanged]: "history-changed",
  [CHAT_MESSAGE_EDIT_ERROR_CODE.targetMissing]: "target-missing",
  [CHAT_MESSAGE_EDIT_ERROR_CODE.targetNotUserMessage]: "target-missing",
  [CHAT_MESSAGE_EDIT_ERROR_CODE.turnRunning]: "refused",
} as const satisfies Record<ChatMessageEditErrorCode, EditRefusal>;

const isEditErrorCode = (code: string): code is ChatMessageEditErrorCode =>
  Object.hasOwn(EDIT_REFUSALS, code);

/** What the form says of an edit the server did not take. */
export type EditNotice = EditRefusal | SendRefusal;

/**
 * Why the server did not take the edit: the edit's own refusal when the
 * server named one, else a send's (`sendRefusal`), which tells a file it
 * would not take.
 */
export const editNoticeOf = (
  error: ApiError,
  withFiles: boolean,
): EditNotice => {
  const code = error._tag === "ApiRequestError" ? error.code : undefined;
  return code !== undefined && isEditErrorCode(code)
    ? EDIT_REFUSALS[code]
    : sendRefusal(error, withFiles);
};

const COMPUTER_REASON_KEYS = {
  no_checkpoint: "noCheckpoint",
  // A desktop app from before earlier undos refuses any but the newest turn.
  not_newest: "updateForEarlier",
  folder_busy: "folderBusy",
  failed: "failed",
} as const satisfies Record<ChatLocalFilesUndoComputerRefusal, string>;

const REFUSAL_KEYS = {
  thread_busy: "threadBusy",
  no_checkpoint: "noSavedCopy",
  several_folders: "severalFolders",
  folder_shared: "folderShared",
  already_undone: "alreadyUndone",
  desktop_offline: "desktopOffline",
  desktop_update_required: "desktopUpdateRequired",
} as const satisfies Record<ChatLocalFilesUndoRefusal, string>;

/** Under `chat.edit.localFiles`: why the changes cannot be undone. */
type RefusalKey = `refused.${(typeof REFUSAL_KEYS)[ChatLocalFilesUndoRefusal]}`;

/** Under `chat.edit.localFiles`: why an undo the form asked for did not restore the folder. */
type LocalFilesProblemKey =
  | RefusalKey
  | `computer.${(typeof COMPUTER_REASON_KEYS)[ChatLocalFilesUndoComputerRefusal]}`
  | "expired";

const refusalKey = (reason: ChatLocalFilesUndoRefusal): RefusalKey =>
  `refused.${REFUSAL_KEYS[reason]}`;

/**
 * How an undo the form asked for ended: done, refused by the server before
 * it was asked (`refused`) or by the computer (`computer-refused`, `null`
 * when it named no reason), never sent in time, or no longer followed
 * because the form closed.
 */
export type LocalFilesUndoEnd =
  | { readonly type: "restored" }
  | { readonly type: "refused"; readonly reason: ChatLocalFilesUndoRefusal }
  | {
      readonly type: "computer-refused";
      readonly reason: ChatLocalFilesUndoComputerRefusal | null;
    }
  | { readonly type: "expired" }
  | { readonly type: "abandoned" };

/** An undo that did not restore the folder: what the form says of it. */
export type LocalFilesUndoProblem = Exclude<
  LocalFilesUndoEnd,
  { type: "restored" } | { type: "abandoned" }
>;

const localFilesProblemKey = (
  problem: LocalFilesUndoProblem,
): LocalFilesProblemKey => {
  switch (problem.type) {
    case "refused":
      return refusalKey(problem.reason);
    case "computer-refused":
      return `computer.${COMPUTER_REASON_KEYS[problem.reason ?? "failed"]}`;
    case "expired":
      return "expired";
    default:
      problem satisfies never;
      return panic("Unhandled local files undo problem");
  }
};

/**
 * The edit form's file choice:
 * - `hidden`: nothing to offer (a cloud chat, or the read has not arrived);
 * - `offered`: the switch, with the problem the form's last undo ran into;
 * - `unavailable`: the switch shown off and disabled, with why;
 * - `pending`: an undo is on its way, which a send waits for;
 * - `restored`: the changes are undone, so a send sends only the edit.
 */
export type EditFilesChoice =
  | { readonly type: "hidden" }
  | {
      readonly type: "offered";
      readonly checked: boolean;
      readonly problemKey: LocalFilesProblemKey | null;
    }
  | { readonly type: "unavailable"; readonly reasonKey: RefusalKey }
  | { readonly type: "pending" }
  | { readonly type: "restored" };

const SETTLED_STATES: ReadonlySet<ChatLocalFilesUndoState> = new Set(
  CHAT_LOCAL_FILES_UNDO_SETTLED_STATES,
);
/** States the computer may still answer: counted, and not yet settled. */
const PENDING_STATES: ReadonlySet<ChatLocalFilesUndoState> = new Set(
  CHAT_LOCAL_FILES_UNDO_LIVE_STATES.filter(
    (state) => !SETTLED_STATES.has(state),
  ),
);

/**
 * What the edit form offers, from the server's read (`undefined` until it
 * arrives or while it fails), whether the person turned the switch on, and
 * the problem the form's last undo ran into. An undo asked before shows as
 * it stands; one that ended without restoring is offered again.
 */
export const editFilesChoice = ({
  read,
  checked,
  problem,
}: {
  readonly read: ChatLocalFilesUndoRead | undefined;
  readonly checked: boolean;
  readonly problem: LocalFilesUndoProblem | null;
}): EditFilesChoice => {
  if (read === undefined) {
    return { type: "hidden" };
  }
  const state = read.undo?.state;
  if (state === "restored") {
    return { type: "restored" };
  }
  if (state !== undefined && PENDING_STATES.has(state)) {
    return { type: "pending" };
  }
  switch (read.files.type) {
    case "none":
      return { type: "hidden" };
    case "unavailable":
      return { type: "unavailable", reasonKey: refusalKey(read.files.reason) };
    case "available":
      return {
        type: "offered",
        checked,
        problemKey: problem === null ? null : localFilesProblemKey(problem),
      };
    default:
      read.files satisfies never;
      return panic("Unhandled local files undo files");
  }
};

/**
 * Whether sending the edit undoes the files first: when the person turned
 * the switch on, and when an undo is already on its way (the computer
 * refuses a turn in a folder it is restoring).
 */
export const editUndoesFilesFirst = (choice: EditFilesChoice): boolean =>
  choice.type === "pending" || (choice.type === "offered" && choice.checked);

/** Whether the agent starts over from the chat's text after the edit. */
export const editRestartsConversation = (
  read: ChatLocalFilesUndoRead | undefined,
): boolean => read?.conversation.type === "restarts";

const FIRST_POLL_MS = 1000;
const LONGEST_POLL_MS = 15_000;

/** The pause before the next read, as long as the read has been followed. */
const nextPollMs = (followedForMs: number) =>
  Math.min(Math.max(FIRST_POLL_MS, followedForMs), LONGEST_POLL_MS);

/**
 * How long until the form reads again while the read may still change (an
 * undo on its way, or a turn the form stopped as it opened still ending): as
 * long as it has been followed, from a second up to fifteen, as the web
 * does. `false` once nothing is left to wait for.
 */
export const localFilesReadPollMs = ({
  read,
  followedForMs,
}: {
  readonly read: ChatLocalFilesUndoRead | undefined;
  readonly followedForMs: number;
}): number | false => {
  if (read === undefined) {
    return false;
  }
  const state = read.undo?.state;
  const settling =
    (state !== undefined && PENDING_STATES.has(state)) ||
    (read.files.type === "unavailable" && read.files.reason === "thread_busy");
  return settling ? nextPollMs(followedForMs) : false;
};

/** How a request to undo was answered: taken with its undo, or refused with the reason. */
export type LocalFilesUndoRequested =
  | { readonly type: "accepted"; readonly undo: ChatLocalFilesUndo }
  | { readonly type: "refused"; readonly reason: ChatLocalFilesUndoRefusal };

const endOf = (undo: ChatLocalFilesUndo): LocalFilesUndoEnd | null => {
  switch (undo.state) {
    case "queued":
    case "sent":
      return null;
    case "restored":
      return { type: "restored" };
    case "refused":
      return { type: "computer-refused", reason: undo.reason };
    case "expired":
      return { type: "expired" };
    default:
      undo.state satisfies never;
      return panic("Unhandled local files undo state");
  }
};

/**
 * Asks for the undo and follows it until the computer answered, pausing
 * between reads as `localFilesReadPollMs` does. A read whose files are no
 * longer available and that holds no undo ends with the read's reason; a
 * failed read is followed on. `wait` answers `false` once the form closed.
 */
export const followLocalFilesUndo = async ({
  now,
  read,
  request,
  wait,
}: {
  readonly now: () => number;
  readonly read: () => Promise<Result<ChatLocalFilesUndoRead, unknown>>;
  readonly request: () => Promise<Result<LocalFilesUndoRequested, ApiError>>;
  readonly wait: (ms: number) => Promise<boolean>;
}): Promise<Result<LocalFilesUndoEnd, ApiError>> => {
  const asked = await request();
  if (Result.isError(asked)) {
    return asked;
  }
  if (asked.value.type === "refused") {
    return Result.ok({ type: "refused", reason: asked.value.reason });
  }
  const followedSince = now();
  let undo = asked.value.undo;
  for (;;) {
    const ended = endOf(undo);
    if (ended !== null) {
      return Result.ok(ended);
    }
    if (!(await wait(nextPollMs(now() - followedSince)))) {
      return Result.ok({ type: "abandoned" });
    }
    const current = await read();
    if (Result.isOk(current)) {
      const { files, undo: stored } = current.value;
      if (stored !== null) {
        undo = stored;
      } else if (files.type === "unavailable") {
        return Result.ok({ type: "refused", reason: files.reason });
      } else {
        // The undo is gone from the read: nothing restored the folder.
        return Result.ok({ type: "expired" });
      }
    }
  }
};

/** The message whose later file changes an edit may undo. */
type UndoTarget = {
  readonly fetch: Fetch;
  readonly messageId: string;
  readonly source: AccessTokenSource;
  readonly threadId: string;
};

const undoPath = ({
  messageId,
  threadId,
}: Pick<UndoTarget, "messageId" | "threadId">) =>
  `/v1/chat/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/local-files/undo`;

/**
 * What editing the chat from the message does on the person's computer:
 * whether its file changes can be undone, whether the agent continues or
 * starts over, and the undo, if one was asked.
 */
export const readLocalFilesUndo = async ({
  fetch,
  messageId,
  source,
  threadId,
}: UndoTarget): Promise<Result<ChatLocalFilesUndoRead, ApiError>> =>
  await requestApi({
    fetch,
    path: undoPath({ messageId, threadId }),
    schema: chatLocalFilesUndoReadSchema,
    source,
  });

const REFUSED_STATUS = 409;

/**
 * Asks the computer to undo the file changes made since the message. A
 * refusal (409) is an answer, not a failure: the form shows its reason.
 */
export const requestLocalFilesUndo = async ({
  fetch,
  messageId,
  source,
  threadId,
}: UndoTarget): Promise<Result<LocalFilesUndoRequested, ApiError>> => {
  const answered = await requestApi({
    fetch,
    method: "POST",
    path: undoPath({ messageId, threadId }),
    schema: chatLocalFilesUndoAnswerSchema,
    source,
  });
  if (Result.isError(answered)) {
    const { error } = answered;
    if (error._tag === "ApiRequestError" && error.status === REFUSED_STATUS) {
      const refusal = v.safeParse(
        chatLocalFilesUndoAnswerSchema,
        error.refusal,
      );
      if (refusal.success && refusal.output.status === "refused") {
        return Result.ok({ type: "refused", reason: refusal.output.reason });
      }
    }
    return answered;
  }
  const answer = answered.value;
  switch (answer.status) {
    case "accepted":
      return Result.ok({ type: "accepted", undo: answer.undo });
    case "refused":
      return Result.ok({ type: "refused", reason: answer.reason });
    default:
      answer satisfies never;
      return panic("Unhandled local files undo answer");
  }
};
