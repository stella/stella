import { describe, expect, test } from "bun:test";

import {
  CHAT_LOCAL_FILES_UNDO_COMPUTER_REASONS,
  CHAT_LOCAL_FILES_UNDO_REQUEST_REFUSALS,
} from "@stll/api-contract/chat-local-files-undo";

import {
  type LocalFilesUndoComputerReason,
  localFilesUndoPollMs,
  type LocalFilesUndoRead,
  type LocalFilesUndoState,
  type LocalFilesUndoView,
  localFilesUndoView,
} from "@/features/chat/local-files-undo.logic";

const undo = (
  state: LocalFilesUndoState,
  reason: LocalFilesUndoComputerReason | null = null,
): LocalFilesUndoRead => ({
  undoable: true,
  undo: { restoreId: "restore-1", state, reason },
});

describe("what the newest turn's row shows of its undo", () => {
  test("nothing until the read arrives, and nothing for a turn without a checkpoint", () => {
    expect(localFilesUndoView({ read: undefined, refusal: null })).toEqual({
      canUndo: false,
      status: { type: "none" },
    });
    expect(
      localFilesUndoView({
        read: { undoable: false, undo: null },
        refusal: null,
      }),
    ).toEqual({ canUndo: false, status: { type: "none" } });
  });

  test("a turn that can be undone offers the action", () => {
    expect(
      localFilesUndoView({
        read: { undoable: true, undo: null },
        refusal: null,
      }),
    ).toEqual({ canUndo: true, status: { type: "none" } });
  });

  test("a queued or sent undo is pending, and a restored one is a lasting marker", () => {
    const pending: LocalFilesUndoView = {
      canUndo: false,
      status: { type: "pending" },
    };
    expect(localFilesUndoView({ read: undo("queued"), refusal: null })).toEqual(
      pending,
    );
    expect(localFilesUndoView({ read: undo("sent"), refusal: null })).toEqual(
      pending,
    );
    expect(
      localFilesUndoView({ read: undo("restored"), refusal: null }),
    ).toEqual({ canUndo: false, status: { type: "restored" } });
  });

  test("each of the computer's reasons gets its own message, and the undo may be asked again", () => {
    const keys = CHAT_LOCAL_FILES_UNDO_COMPUTER_REASONS.map((reason) => {
      const view = localFilesUndoView({
        read: undo("refused", reason),
        refusal: null,
      });
      expect(view.canUndo).toBe(true);
      return view.status.type === "problem" ? view.status.messageKey : null;
    });
    expect(new Set(keys).size).toBe(
      CHAT_LOCAL_FILES_UNDO_COMPUTER_REASONS.length,
    );
    expect(keys).not.toContain(null);
  });

  test("an expired undo says the computer did not answer in time and can be tried again", () => {
    expect(
      localFilesUndoView({ read: undo("expired"), refusal: null }),
    ).toEqual({
      canUndo: true,
      status: { type: "problem", messageKey: "chat.localFilesUndo.expired" },
    });
  });

  test("each refused request gets its own message, unless the undo is already on its way or done", () => {
    const keys = CHAT_LOCAL_FILES_UNDO_REQUEST_REFUSALS.map((refusal) => {
      const view = localFilesUndoView({
        read: { undoable: true, undo: null },
        refusal,
      });
      return view.status.type === "problem" ? view.status.messageKey : null;
    });
    expect(new Set(keys).size).toBe(
      CHAT_LOCAL_FILES_UNDO_REQUEST_REFUSALS.length,
    );
    expect(keys).toContain("chat.localFilesUndo.refused.desktopOffline");
    // A refusal answered after an expired undo replaces the old message.
    expect(
      localFilesUndoView({ read: undo("expired"), refusal: "desktop_offline" })
        .status,
    ).toEqual({
      type: "problem",
      messageKey: "chat.localFilesUndo.refused.desktopOffline",
    });
    expect(
      localFilesUndoView({ read: undo("restored"), refusal: "not_newest" })
        .status,
    ).toEqual({ type: "restored" });
  });
});

describe("following an undo until it settles", () => {
  test("the read is asked again with a doubling pause, capped, and stops once settled", () => {
    const pauses = [0, 1, 2, 3, 4, 5, 10].map((polls) =>
      localFilesUndoPollMs({ read: undo("sent"), polls }),
    );
    expect(pauses).toEqual([1000, 2000, 4000, 8000, 15_000, 15_000, 15_000]);
    for (const read of [undo("restored"), undo("refused"), undo("expired")]) {
      expect(localFilesUndoPollMs({ read, polls: 1 })).toBe(false);
    }
    expect(localFilesUndoPollMs({ read: undefined, polls: 0 })).toBe(false);
  });
});
