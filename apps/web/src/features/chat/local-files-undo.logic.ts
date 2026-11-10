import { panic } from "better-result";
import * as v from "valibot";

import {
  CHAT_LOCAL_FILES_UNDO_PENDING_STATES,
  CHAT_LOCAL_FILES_UNDO_REQUEST_REFUSALS,
  type ChatLocalFilesUndoComputerReason,
  type ChatLocalFilesUndoRequestRefusal,
  type ChatLocalFilesUndoState,
} from "@stll/api-contract/chat-local-files-undo";

import type { TranslationKey } from "@/i18n/types";

/**
 * Undoing the file changes the newest turn of a chat made on the member's
 * computer: what the turn's row shows, from where the server says the undo
 * stands (`GET …/turns/:turnId/local-files/undo`) and from the answer the
 * last request got.
 */

export type LocalFilesUndoState = ChatLocalFilesUndoState;
export type LocalFilesUndoComputerReason = ChatLocalFilesUndoComputerReason;
export type LocalFilesUndoRequestRefusal = ChatLocalFilesUndoRequestRefusal;

export type LocalFilesUndoRead = {
  undoable: boolean;
  undo: {
    restoreId: string;
    state: LocalFilesUndoState;
    reason: LocalFilesUndoComputerReason | null;
  } | null;
};

/** The body of a refused undo request (409). */
export const localFilesUndoRefusalSchema = v.object({
  status: v.literal("refused"),
  reason: v.picklist(CHAT_LOCAL_FILES_UNDO_REQUEST_REFUSALS),
});

const COMPUTER_REASON_KEYS = {
  no_checkpoint: "chat.localFilesUndo.computer.noCheckpoint",
  not_newest: "chat.localFilesUndo.computer.notNewest",
  folder_busy: "chat.localFilesUndo.computer.folderBusy",
  failed: "chat.localFilesUndo.computer.failed",
} as const satisfies Record<LocalFilesUndoComputerReason, TranslationKey>;

const REQUEST_REFUSAL_KEYS = {
  not_newest: "chat.localFilesUndo.refused.notNewest",
  thread_busy: "chat.localFilesUndo.refused.threadBusy",
  no_checkpoint: "chat.localFilesUndo.refused.noCheckpoint",
  desktop_offline: "chat.localFilesUndo.refused.desktopOffline",
} as const satisfies Record<LocalFilesUndoRequestRefusal, TranslationKey>;

/** The messages a turn's row can show about its undo. */
type LocalFilesUndoMessageKey =
  | (typeof COMPUTER_REASON_KEYS)[LocalFilesUndoComputerReason]
  | (typeof REQUEST_REFUSAL_KEYS)[LocalFilesUndoRequestRefusal]
  | "chat.localFilesUndo.expired";

/**
 * What the turn's row shows. `canUndo` offers the action; `status` is the
 * line beside the row's actions, if any.
 */
export type LocalFilesUndoView = {
  canUndo: boolean;
  status:
    | { type: "none" }
    | { type: "pending" }
    | { type: "restored" }
    | { type: "problem"; messageKey: LocalFilesUndoMessageKey };
};

const NOTHING = { canUndo: false, status: { type: "none" } } as const;

/**
 * The row of the newest turn, from the server's read of its undo (`read`,
 * `undefined` until it arrives) and the refusal the last request got, if any.
 * A refused or expired undo may be asked again while the turn can be undone.
 */
export const localFilesUndoView = ({
  read,
  refusal,
}: {
  read: LocalFilesUndoRead | undefined;
  refusal: LocalFilesUndoRequestRefusal | null;
}): LocalFilesUndoView => {
  if (read === undefined) {
    return NOTHING;
  }
  const settled = settledView(read);
  // The member's last request answers for itself, unless the undo it asked
  // for is now on its way or done.
  return refusal !== null &&
    (settled.status.type === "none" || settled.status.type === "problem")
    ? {
        canUndo: settled.canUndo,
        status: { type: "problem", messageKey: REQUEST_REFUSAL_KEYS[refusal] },
      }
    : settled;
};

const settledView = ({
  undo,
  undoable,
}: LocalFilesUndoRead): LocalFilesUndoView => {
  if (undo === null) {
    return { canUndo: undoable, status: { type: "none" } };
  }
  switch (undo.state) {
    case "queued":
    case "sent":
      return { canUndo: false, status: { type: "pending" } };
    case "restored":
      return { canUndo: false, status: { type: "restored" } };
    case "refused":
      return {
        canUndo: undoable,
        status: {
          type: "problem",
          messageKey:
            undo.reason === null
              ? COMPUTER_REASON_KEYS.failed
              : COMPUTER_REASON_KEYS[undo.reason],
        },
      };
    case "expired":
      return {
        canUndo: undoable,
        status: {
          type: "problem",
          messageKey: "chat.localFilesUndo.expired",
        },
      };
    default:
      undo.state satisfies never;
      return panic("Unhandled local files undo state");
  }
};

/** Whether the computer may still answer: the read is followed until not. */
const PENDING_STATES: ReadonlySet<LocalFilesUndoState> = new Set(
  CHAT_LOCAL_FILES_UNDO_PENDING_STATES,
);

export const localFilesUndoSettling = (
  read: LocalFilesUndoRead | undefined,
): boolean => {
  const state = read?.undo?.state;
  return state !== undefined && PENDING_STATES.has(state);
};

const FIRST_POLL_MS = 1000;
const LONGEST_POLL_MS = 15_000;

/**
 * How long until the read is asked again while the undo settles: doubling
 * from a second, up to fifteen, so a quick computer answers fast and a slow
 * one is not asked too often. `false` once it settled.
 */
export const localFilesUndoPollMs = ({
  read,
  polls,
}: {
  read: LocalFilesUndoRead | undefined;
  polls: number;
}): number | false =>
  localFilesUndoSettling(read)
    ? Math.min(FIRST_POLL_MS * 2 ** Math.max(0, polls), LONGEST_POLL_MS)
    : false;
