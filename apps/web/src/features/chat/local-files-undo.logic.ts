import { panic, type Result } from "better-result";

import {
  CHAT_LOCAL_FILES_UNDO_LIVE_STATES,
  CHAT_LOCAL_FILES_UNDO_SETTLED_STATES,
  type ChatLocalFilesUndo,
  type ChatLocalFilesUndoComputerRefusal,
  type ChatLocalFilesUndoRead,
  type ChatLocalFilesUndoRefusal,
  type ChatLocalFilesUndoState,
} from "@stll/api-contract/chat-local-files-undo";

import type { TranslationKey } from "@/i18n/types";

/**
 * Undoing the file changes made on the member's computer since one of their
 * messages, as part of editing the chat from it: what the edit form offers,
 * from the server's read (`GET …/messages/:messageId/local-files/undo`), and
 * how an undo the form asks for is followed until it ends.
 */

const COMPUTER_REASON_KEYS = {
  no_checkpoint: "chat.localFilesUndo.computer.noCheckpoint",
  // A desktop app from before earlier undos refuses any but the newest turn.
  not_newest: "chat.localFilesUndo.computer.updateForEarlier",
  folder_busy: "chat.localFilesUndo.computer.folderBusy",
  failed: "chat.localFilesUndo.computer.failed",
} as const satisfies Record<ChatLocalFilesUndoComputerRefusal, TranslationKey>;

const REFUSAL_KEYS = {
  thread_busy: "chat.localFilesUndo.refused.threadBusy",
  no_checkpoint: "chat.localFilesUndo.refused.noSavedCopy",
  several_folders: "chat.localFilesUndo.refused.severalFolders",
  folder_shared: "chat.localFilesUndo.refused.folderShared",
  already_undone: "chat.localFilesUndo.refused.alreadyUndone",
  desktop_offline: "chat.localFilesUndo.refused.desktopOffline",
  desktop_update_required: "chat.localFilesUndo.refused.desktopUpdateRequired",
} as const satisfies Record<ChatLocalFilesUndoRefusal, TranslationKey>;

/**
 * How an undo the form asked for ended: done, refused by the server before
 * it was asked (`refused`) or by the computer (`computer-refused`, `null`
 * when it named no reason), never sent in time, or no longer followed
 * because the form closed.
 */
export type LocalFilesUndoEnd =
  | { type: "restored" }
  | { type: "refused"; reason: ChatLocalFilesUndoRefusal }
  | {
      type: "computer-refused";
      reason: ChatLocalFilesUndoComputerRefusal | null;
    }
  | { type: "expired" }
  | { type: "abandoned" };

/** An undo that did not restore the folder: what the form says of it. */
export type LocalFilesUndoProblem = Exclude<
  LocalFilesUndoEnd,
  { type: "restored" } | { type: "abandoned" }
>;

type LocalFilesUndoProblemKey =
  | (typeof COMPUTER_REASON_KEYS)[ChatLocalFilesUndoComputerRefusal]
  | (typeof REFUSAL_KEYS)[ChatLocalFilesUndoRefusal]
  | "chat.localFilesUndo.expired";

const problemKey = (
  problem: LocalFilesUndoProblem,
): LocalFilesUndoProblemKey => {
  switch (problem.type) {
    case "refused":
      return REFUSAL_KEYS[problem.reason];
    case "computer-refused":
      return problem.reason === null
        ? COMPUTER_REASON_KEYS.failed
        : COMPUTER_REASON_KEYS[problem.reason];
    case "expired":
      return "chat.localFilesUndo.expired";
    default:
      problem satisfies never;
      return panic("Unhandled local files undo problem");
  }
};

/**
 * The edit form's file choice:
 * - `hidden`: nothing to offer (a cloud chat, or the read has not arrived);
 * - `offered`: the box, with the problem the form's last undo ran into;
 * - `unavailable`: the box shown disabled, with why;
 * - `pending`: an undo is on its way, which a send waits for;
 * - `restored`: the changes are undone, so a send sends only the edit.
 */
export type EditLocalFilesChoice =
  | { type: "hidden" }
  | {
      type: "offered";
      checked: boolean;
      problemKey: LocalFilesUndoProblemKey | null;
    }
  | {
      type: "unavailable";
      reasonKey: (typeof REFUSAL_KEYS)[ChatLocalFilesUndoRefusal];
    }
  | { type: "pending" }
  | { type: "restored" };

/** States the computer may still answer: counted, and not yet settled. */
const SETTLED_STATES: ReadonlySet<ChatLocalFilesUndoState> = new Set(
  CHAT_LOCAL_FILES_UNDO_SETTLED_STATES,
);
const PENDING_STATES: ReadonlySet<ChatLocalFilesUndoState> = new Set(
  CHAT_LOCAL_FILES_UNDO_LIVE_STATES.filter(
    (state) => !SETTLED_STATES.has(state),
  ),
);

/**
 * What the edit form offers, from the server's read (`undefined` until it
 * arrives or while it fails), whether the member checked the box, and the
 * problem the form's last undo ran into. An undo asked before shows as it
 * stands; one that ended without restoring is offered again.
 */
export const editLocalFilesChoice = ({
  read,
  checked,
  problem,
}: {
  read: ChatLocalFilesUndoRead | undefined;
  checked: boolean;
  problem: LocalFilesUndoProblem | null;
}): EditLocalFilesChoice => {
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
      return {
        type: "unavailable",
        reasonKey: REFUSAL_KEYS[read.files.reason],
      };
    case "available":
      return {
        type: "offered",
        checked,
        problemKey: problem === null ? null : problemKey(problem),
      };
    default:
      read.files satisfies never;
      return panic("Unhandled local files undo files");
  }
};

/**
 * Whether sending the edit undoes the files first: when the member checked
 * the box, and when an undo is already on its way (the computer refuses a
 * turn in a folder it is restoring).
 */
export const editUndoesFilesFirst = (choice: EditLocalFilesChoice): boolean =>
  choice.type === "pending" || (choice.type === "offered" && choice.checked);

/** Whether the agent starts over from the chat's text after the edit. */
export const editRestartsConversation = (
  read: ChatLocalFilesUndoRead | undefined,
): boolean => read?.conversation.type === "restarts";

/** Whether the read is followed: while an undo or a turn of the thread may still change it. */
const localFilesUndoSettling = (
  read: ChatLocalFilesUndoRead | undefined,
): boolean => {
  if (read === undefined) {
    return false;
  }
  const state = read.undo?.state;
  if (state !== undefined && PENDING_STATES.has(state)) {
    return true;
  }
  // A turn the form stopped as it opened is still ending.
  return (
    read.files.type === "unavailable" && read.files.reason === "thread_busy"
  );
};

const FIRST_POLL_MS = 1000;
const LONGEST_POLL_MS = 15_000;

/** The pause before the next read, as long as the read has been followed. */
const nextPollMs = (pendingForMs: number) =>
  Math.min(Math.max(FIRST_POLL_MS, pendingForMs), LONGEST_POLL_MS);

/**
 * How long until the read is asked again while it may change: as long as it
 * has been followed, from a second up to fifteen, so the reads land at 1, 2,
 * 4, 8 and 16 seconds and then every 15, whether or not a read failed. A
 * quick computer answers fast and a slow one is not asked too often.
 * `false` once nothing is left to wait for.
 */
export const localFilesUndoPollMs = ({
  read,
  pendingForMs,
}: {
  read: ChatLocalFilesUndoRead | undefined;
  pendingForMs: number;
}): number | false =>
  localFilesUndoSettling(read) ? nextPollMs(pendingForMs) : false;

/** How a request to undo was answered: taken with its undo, or refused with the reason. */
export type LocalFilesUndoRequested =
  | { type: "accepted"; undo: ChatLocalFilesUndo }
  | { type: "refused"; reason: ChatLocalFilesUndoRefusal };

type FollowOptions = {
  /** Ask for the undo; a repeated ask answers the same undo. */
  request: () => Promise<LocalFilesUndoRequested>;
  /** Read where it stands; a failed read is followed on. */
  read: () => Promise<Result<ChatLocalFilesUndoRead, unknown>>;
  /** Wait `ms`; `false` when the form closed meanwhile. */
  wait: (ms: number) => Promise<boolean>;
  /** Epoch ms. */
  now: () => number;
};

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
 * Ask for the undo and follow it until the computer answered, with the
 * pause `localFilesUndoPollMs` takes between reads. A read whose files are
 * no longer available and that holds no undo ends with the read's reason.
 */
export const followLocalFilesUndo = async ({
  request,
  read,
  wait,
  now,
}: FollowOptions): Promise<LocalFilesUndoEnd> => {
  const asked = await request();
  if (asked.type === "refused") {
    return { type: "refused", reason: asked.reason };
  }
  const followedSince = now();
  let undo = asked.undo;
  for (;;) {
    const ended = endOf(undo);
    if (ended !== null) {
      return ended;
    }
    if (!(await wait(nextPollMs(now() - followedSince)))) {
      return { type: "abandoned" };
    }
    const current = await read();
    if (current.isOk()) {
      const { files, undo: stored } = current.value;
      if (stored !== null) {
        undo = stored;
      } else if (files.type === "unavailable") {
        return { type: "refused", reason: files.reason };
      } else {
        // The undo is gone from the read: nothing restored the folder.
        return { type: "expired" };
      }
    }
  }
};
