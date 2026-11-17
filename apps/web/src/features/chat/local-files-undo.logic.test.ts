import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  CHAT_LOCAL_FILES_UNDO_COMPUTER_REFUSALS,
  CHAT_LOCAL_FILES_UNDO_REFUSALS,
  CHAT_LOCAL_FILES_UNDO_SETTLED_STATES,
  CHAT_LOCAL_FILES_UNDO_STATES,
  type ChatLocalFilesUndo,
  type ChatLocalFilesUndoComputerRefusal,
  type ChatLocalFilesUndoFiles,
  type ChatLocalFilesUndoRead,
  type ChatLocalFilesUndoState,
} from "@stll/api-contract/chat-local-files-undo";

import {
  editLocalFilesChoice,
  editRestartsConversation,
  editUndoesFilesFirst,
  followLocalFilesUndo,
  localFilesUndoPollMs,
  type LocalFilesUndoRequested,
} from "@/features/chat/local-files-undo.logic";

const AVAILABLE: ChatLocalFilesUndoFiles = { type: "available" };

const SETTLED: ReadonlySet<ChatLocalFilesUndoState> = new Set(
  CHAT_LOCAL_FILES_UNDO_SETTLED_STATES,
);
/** The states the computer may still answer. */
const PENDING_STATES = CHAT_LOCAL_FILES_UNDO_STATES.filter(
  (state) => !SETTLED.has(state),
);

const undoIn = (
  state: ChatLocalFilesUndoState,
  reason: ChatLocalFilesUndoComputerRefusal | null = null,
): ChatLocalFilesUndo => ({ restoreId: "restore-1", state, reason });

const readOf = (
  files: ChatLocalFilesUndoFiles,
  undo: ChatLocalFilesUndo | null = null,
): ChatLocalFilesUndoRead => ({
  files,
  conversation: { type: "continues" },
  undo,
});

describe("the edit form's file choice", () => {
  test("nothing until the read arrives, and nothing for a chat whose turns touched no folder", () => {
    expect(
      editLocalFilesChoice({ read: undefined, checked: false, problem: null }),
    ).toEqual({ type: "hidden" });
    expect(
      editLocalFilesChoice({
        read: readOf({ type: "none" }),
        checked: false,
        problem: null,
      }),
    ).toEqual({ type: "hidden" });
  });

  test("undoable changes offer the box as the member left it", () => {
    for (const checked of [false, true]) {
      expect(
        editLocalFilesChoice({
          read: readOf(AVAILABLE),
          checked,
          problem: null,
        }),
      ).toEqual({ type: "offered", checked, problemKey: null });
    }
  });

  test("each reason the changes cannot be undone shows its own message on a disabled box", () => {
    const keys = CHAT_LOCAL_FILES_UNDO_REFUSALS.map((reason) => {
      const choice = editLocalFilesChoice({
        read: readOf({ type: "unavailable", reason }),
        checked: true,
        problem: null,
      });
      return choice.type === "unavailable" ? choice.reasonKey : null;
    });
    expect(keys).not.toContain(null);
    expect(new Set(keys).size).toBe(CHAT_LOCAL_FILES_UNDO_REFUSALS.length);
  });

  test("an undo on its way or done shows as it stands, whatever the files read", () => {
    for (const files of [
      AVAILABLE,
      { type: "unavailable", reason: "desktop_offline" } as const,
    ]) {
      for (const state of PENDING_STATES) {
        expect(
          editLocalFilesChoice({
            read: readOf(files, undoIn(state)),
            checked: false,
            problem: null,
          }),
        ).toEqual({ type: "pending" });
      }
      expect(
        editLocalFilesChoice({
          read: readOf(files, undoIn("restored")),
          checked: true,
          problem: null,
        }),
      ).toEqual({ type: "restored" });
    }
  });

  test("an undo that ended without restoring is offered again, with what the form's last undo ran into", () => {
    for (const ended of [undoIn("refused", "folder_busy"), undoIn("expired")]) {
      expect(
        editLocalFilesChoice({
          read: readOf(AVAILABLE, ended),
          checked: false,
          problem: null,
        }),
      ).toEqual({ type: "offered", checked: false, problemKey: null });
    }
    const computerKeys = [...CHAT_LOCAL_FILES_UNDO_COMPUTER_REFUSALS, null].map(
      (reason) => {
        const choice = editLocalFilesChoice({
          read: readOf(AVAILABLE),
          checked: false,
          problem: { type: "computer-refused", reason },
        });
        return choice.type === "offered" ? choice.problemKey : null;
      },
    );
    expect(computerKeys).not.toContain(null);
    // A computer that names no reason reads as a failed undo.
    expect(new Set(computerKeys).size).toBe(
      CHAT_LOCAL_FILES_UNDO_COMPUTER_REFUSALS.length,
    );
    // A desktop app from before earlier undos asks for its update.
    expect(
      editLocalFilesChoice({
        read: readOf(AVAILABLE),
        checked: false,
        problem: { type: "computer-refused", reason: "not_newest" },
      }),
    ).toEqual({
      type: "offered",
      checked: false,
      problemKey: "chat.localFilesUndo.computer.updateForEarlier",
    });
  });

  test("a send undoes the files first only when the box is checked or an undo is already on its way", () => {
    expect(
      editUndoesFilesFirst({
        type: "offered",
        checked: true,
        problemKey: null,
      }),
    ).toBe(true);
    expect(editUndoesFilesFirst({ type: "pending" })).toBe(true);
    for (const choice of [
      { type: "offered", checked: false, problemKey: null },
      { type: "hidden" },
      { type: "restored" },
      {
        type: "unavailable",
        reasonKey: "chat.localFilesUndo.refused.desktopOffline",
      },
    ] as const) {
      expect(editUndoesFilesFirst(choice)).toBe(false);
    }
  });

  test("the agent starts over only when the read says the previous reply did not finish", () => {
    expect(editRestartsConversation(undefined)).toBe(false);
    expect(editRestartsConversation(readOf(AVAILABLE))).toBe(false);
    expect(
      editRestartsConversation({
        ...readOf({ type: "none" }),
        conversation: { type: "restarts", reason: "previous_not_finished" },
      }),
    ).toBe(true);
  });
});

describe("reading again while the read may change", () => {
  test("the reads land at a doubling pause from a second, capped at fifteen, and stop once settled", () => {
    const readsAt: number[] = [];
    let followedFor = 0;
    for (let reads = 0; reads < 8; reads += 1) {
      const pause = localFilesUndoPollMs({
        read: readOf(AVAILABLE, undoIn("sent")),
        pendingForMs: followedFor,
      });
      if (pause === false) {
        throw new TypeError("Expected a pending undo to be followed");
      }
      followedFor += pause;
      readsAt.push(followedFor);
    }
    expect(readsAt).toEqual([
      1000, 2000, 4000, 8000, 16_000, 31_000, 46_000, 61_000,
    ]);
    for (const state of CHAT_LOCAL_FILES_UNDO_SETTLED_STATES) {
      expect(
        localFilesUndoPollMs({
          read: readOf(AVAILABLE, undoIn(state)),
          pendingForMs: 1000,
        }),
      ).toBe(false);
    }
    expect(localFilesUndoPollMs({ read: undefined, pendingForMs: 0 })).toBe(
      false,
    );
  });

  test("a turn still ending is read again until the chat is idle; any other refusal is not", () => {
    expect(
      localFilesUndoPollMs({
        read: readOf({ type: "unavailable", reason: "thread_busy" }),
        pendingForMs: 0,
      }),
    ).toBe(1000);
    for (const reason of CHAT_LOCAL_FILES_UNDO_REFUSALS.filter(
      (refusal) => refusal !== "thread_busy",
    )) {
      expect(
        localFilesUndoPollMs({
          read: readOf({ type: "unavailable", reason }),
          pendingForMs: 0,
        }),
      ).toBe(false);
    }
  });
});

type FollowScript = {
  answer: LocalFilesUndoRequested;
  /** What each read answers, in order; `"fail"` is a failed read. */
  reads: (ChatLocalFilesUndoRead | "fail")[];
  /** The form closes before this wait (0-based); never by default. */
  closesAt?: number;
};

/** Follow an undo against scripted answers; what was asked, in order. */
const follow = async ({ answer, reads, closesAt }: FollowScript) => {
  const calls: string[] = [];
  const waits: number[] = [];
  let clock = 0;
  const end = await followLocalFilesUndo({
    request: async () => {
      calls.push("request");
      return await Promise.resolve(answer);
    },
    read: async () => {
      calls.push("read");
      const next = reads.shift();
      if (next === undefined) {
        throw new TypeError("Read more often than scripted");
      }
      return await Promise.resolve(
        next === "fail"
          ? Result.err(new TypeError("offline"))
          : Result.ok(next),
      );
    },
    wait: async (ms) => {
      if (closesAt === waits.length) {
        return await Promise.resolve(false);
      }
      waits.push(ms);
      clock += ms;
      return await Promise.resolve(true);
    },
    now: () => clock,
  });
  return { end, calls, waits };
};

describe("following an undo the form asked for", () => {
  test("a refused request ends at once with its reason and reads nothing", async () => {
    expect(
      await follow({
        answer: { type: "refused", reason: "desktop_offline" },
        reads: [],
      }),
    ).toEqual({
      end: { type: "refused", reason: "desktop_offline" },
      calls: ["request"],
      waits: [],
    });
  });

  test("an undo answered as done needs no read", async () => {
    expect(
      await follow({
        answer: { type: "accepted", undo: undoIn("restored") },
        reads: [],
      }),
    ).toEqual({ end: { type: "restored" }, calls: ["request"], waits: [] });
  });

  test("a pending undo is read at a growing pause until the computer answers, through a failed read", async () => {
    const { end, waits } = await follow({
      answer: { type: "accepted", undo: undoIn("queued") },
      reads: [
        readOf(AVAILABLE, undoIn("sent")),
        "fail",
        // The computer went away after it restored: the undo still counts.
        readOf(
          { type: "unavailable", reason: "desktop_offline" },
          undoIn("restored"),
        ),
      ],
    });
    expect(end).toEqual({ type: "restored" });
    expect(waits).toEqual([1000, 1000, 2000]);
  });

  test("an undo the computer refused or never got ends with why", async () => {
    expect(
      (
        await follow({
          answer: { type: "accepted", undo: undoIn("sent") },
          reads: [readOf(AVAILABLE, undoIn("refused", "folder_busy"))],
        })
      ).end,
    ).toEqual({ type: "computer-refused", reason: "folder_busy" });
    expect(
      (
        await follow({
          answer: { type: "accepted", undo: undoIn("queued") },
          reads: [readOf(AVAILABLE, undoIn("expired"))],
        })
      ).end,
    ).toEqual({ type: "expired" });
  });

  test("a read that lost the undo ends with the read's reason, or as expired", async () => {
    expect(
      (
        await follow({
          answer: { type: "accepted", undo: undoIn("queued") },
          reads: [readOf({ type: "unavailable", reason: "thread_busy" })],
        })
      ).end,
    ).toEqual({ type: "refused", reason: "thread_busy" });
    expect(
      (
        await follow({
          answer: { type: "accepted", undo: undoIn("queued") },
          reads: [readOf(AVAILABLE)],
        })
      ).end,
    ).toEqual({ type: "expired" });
  });

  test("a form that closed stops following and reads no more", async () => {
    expect(
      await follow({
        answer: { type: "accepted", undo: undoIn("queued") },
        reads: [readOf(AVAILABLE, undoIn("sent"))],
        closesAt: 1,
      }),
    ).toEqual({
      end: { type: "abandoned" },
      calls: ["request", "read"],
      waits: [1000],
    });
  });
});
