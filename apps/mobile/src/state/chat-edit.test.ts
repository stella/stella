import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type {
  ChatLocalFilesUndo,
  ChatLocalFilesUndoRead,
} from "@stll/api-contract/chat-local-files-undo";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
  type StoredSession,
} from "@/connection/session";

import { ApiRequestError } from "./api-request";
import {
  editDraftOf,
  editedEntry,
  editedMessageParts,
  editFilesChoice,
  editNoticeOf,
  editRestartsConversation,
  editUndoesFilesFirst,
  entriesBefore,
  followLocalFilesUndo,
  hasEditContent,
  localFilesReadPollMs,
  messageActions,
  readLocalFilesUndo,
  requestLocalFilesUndo,
  shownBeforeEdit,
} from "./chat-edit";
import type { LocalFilesUndoRequested } from "./chat-edit";
import type { ChatEntry } from "./chat-messages";
import { chatEditBody } from "./chat-stream";

const SESSION: StoredSession = {
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId:
    "https://stella.example.com/v1/mcp/oauth/mobile-client-metadata.json",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  signInId: "sign-in-1",
  refreshToken: "refresh-1",
  userId: "user-1",
};

const sourceFor = (fetch: Fetch) => {
  const store = createSessionStore({
    read: async () => SESSION,
    write: async () => {},
    prepareClear: async () => {},
    clear: async () => {},
  });
  return createAccessTokenSource({
    fetch,
    initialAccess: { token: "access-0", expiresAt: Number.MAX_SAFE_INTEGER },
    now: () => 0,
    session: SESSION,
    store,
    generation: store.generation(),
  });
};

const CREATED_AT = "2026-11-16T10:00:00.000Z";
const THREAD_ID = "thread-1";
const MESSAGE_ID = "message-2";
const UNDO_ID = "6f1c9a52-3b0e-4f7a-9c2d-8e4b1a7d5c30";

const LEASE = {
  type: "document",
  source: {
    type: "url",
    value: "userfile://f1",
    mimeType: "application/pdf",
  },
  metadata: { filename: "Lease.pdf" },
};
const PASTED = {
  type: "text",
  content: "\n  Clause 4: rent\nis due monthly",
  metadata: { type: "pasted_text" },
};

const entry = (
  id: string,
  role: ChatEntry["role"] = "user",
  parts?: readonly unknown[],
): ChatEntry => ({
  id,
  role,
  createdAt: CREATED_AT,
  text: id,
  blocks: [],
  files: [],
  drafts: [],
  contextNotice: null,
  ...(parts === undefined ? {} : { parts }),
});

const undo = (state: ChatLocalFilesUndo["state"]): ChatLocalFilesUndo => ({
  restoreId: UNDO_ID,
  state,
  reason: state === "refused" ? "folder_busy" : null,
});

const CONTINUES: ChatLocalFilesUndoRead["conversation"] = {
  type: "continues",
};

const readOf = (
  files: ChatLocalFilesUndoRead["files"],
  stored: ChatLocalFilesUndo | null = null,
  conversation: ChatLocalFilesUndoRead["conversation"] = CONTINUES,
): ChatLocalFilesUndoRead => ({ files, conversation, undo: stored });

const AVAILABLE = { type: "available" } as const;

describe("the long press on a message", () => {
  test("offers to edit a stored message of the person's", () => {
    expect(
      messageActions(entry("m1", "user", [{ type: "text", content: "Hi" }])),
    ).toEqual(["edit"]);
  });

  test("offers nothing on an answer or on a message still being sent", () => {
    expect(messageActions(entry("a1", "assistant"))).toEqual([]);
    // The live copy of a message sent from here has no stored parts yet.
    expect(messageActions(entry("m2"))).toEqual([]);
  });
});

describe("the edit's draft", () => {
  test("edits the message's own text and carries its files and pastes on as stored", () => {
    const draft = editDraftOf([
      { type: "text", content: "  Check the lease  " },
      LEASE,
      PASTED,
      { type: "text", content: "and the annex" },
      { type: "thinking", content: "never shown" },
    ]);
    expect(draft.text).toBe("Check the lease\n\nand the annex");
    expect(draft.kept).toEqual([
      { key: "1", name: "Lease.pdf", mimeType: "application/pdf", part: LEASE },
      // A paste reads as its first line with words, as its chip on the web.
      {
        key: "2",
        name: "  Clause 4: rent",
        mimeType: "text/plain",
        part: PASTED,
      },
    ]);
  });

  test("sends the edited text first, then what it carries on, unchanged", () => {
    const draft = editDraftOf([{ type: "text", content: "Old" }, LEASE]);
    expect(editedMessageParts({ ...draft, text: " New words " })).toEqual([
      { type: "text", content: "New words" },
      LEASE,
    ]);
    // A message of files alone sends no empty text.
    expect(editedMessageParts({ ...draft, text: "  " })).toEqual([LEASE]);
  });

  test("sends only when text or a file is left", () => {
    expect(hasEditContent({ text: " ", kept: [] })).toBe(false);
    expect(hasEditContent({ text: "Hi", kept: [] })).toBe(true);
    expect(hasEditContent(editDraftOf([LEASE]))).toBe(true);
  });

  test("shows the edited message with its files' names while its answer runs", () => {
    expect(
      editedEntry({
        createdAt: CREATED_AT,
        draft: { ...editDraftOf([LEASE]), text: "New words " },
        messageId: MESSAGE_ID,
      }),
    ).toEqual({
      id: MESSAGE_ID,
      role: "user",
      createdAt: CREATED_AT,
      text: "New words",
      blocks: [],
      files: [{ name: "Lease.pdf", mimeType: "application/pdf" }],
      drafts: [],
      contextNotice: null,
    });
  });
});

describe("the edit's request", () => {
  const PARTS = [{ type: "text", content: "New words" }];
  const LOCAL = {
    kind: "local",
    harness: "codex",
    model: "gpt-5-codex",
    approvals: "ask",
    reasoningEffort: null,
  } as const;

  test("sends the message under its own id, cut there, on the thread's computer", () => {
    const body = chatEditBody({
      anonymized: false,
      matterId: undefined,
      messageId: MESSAGE_ID,
      parts: PARTS,
      runId: "run-3",
      runTarget: LOCAL,
      threadId: THREAD_ID,
    });
    expect(body.forwardedProps).toEqual({
      threadId: THREAD_ID,
      runId: "run-3",
      sendMode: "rawOverride",
      runTarget: LOCAL,
      message: { id: MESSAGE_ID, role: "user", parts: PARTS },
      turnIntent: "edit",
      truncateAfterMessageId: MESSAGE_ID,
    });
    // The server refuses an envelope whose copies disagree.
    expect(body.data).toEqual(body.forwardedProps);
    expect(body.messages).toEqual([{ id: MESSAGE_ID, role: "user" }]);
  });

  test("names no target for a cloud chat, and keeps a matter and anonymization", () => {
    expect(
      chatEditBody({
        anonymized: true,
        matterId: "matter-1",
        messageId: MESSAGE_ID,
        parts: PARTS,
        runId: "run-3",
        runTarget: undefined,
        threadId: THREAD_ID,
      }).forwardedProps,
    ).toEqual({
      threadId: THREAD_ID,
      runId: "run-3",
      workspaceId: "matter-1",
      sendMode: "anonymized",
      message: { id: MESSAGE_ID, role: "user", parts: PARTS },
      turnIntent: "edit",
      truncateAfterMessageId: MESSAGE_ID,
    });
  });

  test("says the edit's own refusal in the web's words, else a send's", () => {
    const refused = (code: string | undefined, status = 409) =>
      new ApiRequestError({ message: "refused", status, code });
    expect(editNoticeOf(refused("chat_edit_turn_running"), false)).toBe(
      "refused",
    );
    expect(editNoticeOf(refused("chat_edit_history_changed"), false)).toBe(
      "history-changed",
    );
    expect(editNoticeOf(refused("chat_edit_target_missing"), false)).toBe(
      "target-missing",
    );
    expect(
      editNoticeOf(refused("chat_edit_target_not_user_message"), false),
    ).toBe("target-missing");
    expect(editNoticeOf(refused(undefined, 500), false)).toBe("failed");
    expect(editNoticeOf(refused(undefined, 413), true)).toBe("file-refused");
  });
});

describe("the thread while an edit runs", () => {
  const thread = [entry("m1"), entry("a1"), entry("m2"), entry("a2")];

  test("shows only the messages before the edited one while it runs", () => {
    expect(shownBeforeEdit(thread, "m2").map(({ id }) => id)).toEqual([
      "m1",
      "a1",
    ]);
    expect(shownBeforeEdit(thread, undefined)).toBe(thread);
  });

  test("keeps the messages before it once the server took it", () => {
    expect(entriesBefore(thread, "m2").map(({ id }) => id)).toEqual([
      "m1",
      "a1",
    ]);
    // A message the loaded thread no longer holds cuts nothing.
    expect(entriesBefore(thread, "gone")).toBe(thread);
  });
});

describe("the choice to undo the file changes", () => {
  test("offers nothing in a cloud chat or before the read arrives", () => {
    expect(
      editFilesChoice({
        read: readOf({ type: "none" }),
        checked: false,
        problem: null,
      }),
    ).toEqual({ type: "hidden" });
    expect(
      editFilesChoice({ read: undefined, checked: true, problem: null }),
    ).toEqual({ type: "hidden" });
  });

  test("offers the switch off, with the problem the last undo ran into", () => {
    expect(
      editFilesChoice({
        read: readOf(AVAILABLE),
        checked: false,
        problem: null,
      }),
    ).toEqual({ type: "offered", checked: false, problemKey: null });
    expect(
      editFilesChoice({
        read: readOf(AVAILABLE),
        checked: false,
        problem: { type: "computer-refused", reason: "not_newest" },
      }),
    ).toEqual({
      type: "offered",
      checked: false,
      problemKey: "computer.updateForEarlier",
    });
    expect(
      editFilesChoice({
        read: readOf(AVAILABLE),
        checked: false,
        problem: { type: "computer-refused", reason: null },
      }),
    ).toMatchObject({ problemKey: "computer.failed" });
    expect(
      editFilesChoice({
        read: readOf(AVAILABLE),
        checked: true,
        problem: { type: "expired" },
      }),
    ).toEqual({ type: "offered", checked: true, problemKey: "expired" });
  });

  test("shows why the changes cannot be undone, the edit still offered", () => {
    expect(
      editFilesChoice({
        read: readOf({ type: "unavailable", reason: "desktop_offline" }),
        checked: true,
        problem: null,
      }),
    ).toEqual({ type: "unavailable", reasonKey: "refused.desktopOffline" });
    expect(
      editFilesChoice({
        read: readOf({ type: "unavailable", reason: "no_checkpoint" }),
        checked: false,
        problem: null,
      }),
    ).toEqual({ type: "unavailable", reasonKey: "refused.noSavedCopy" });
  });

  test("shows an undo asked before as it stands", () => {
    expect(
      editFilesChoice({
        read: readOf(AVAILABLE, undo("sent")),
        checked: false,
        problem: null,
      }),
    ).toEqual({ type: "pending" });
    expect(
      editFilesChoice({
        read: readOf(
          { type: "unavailable", reason: "already_undone" },
          undo("restored"),
        ),
        checked: false,
        problem: null,
      }),
    ).toEqual({ type: "restored" });
    // One that ended without restoring is offered again.
    expect(
      editFilesChoice({
        read: readOf(AVAILABLE, undo("expired")),
        checked: false,
        problem: null,
      }),
    ).toMatchObject({ type: "offered" });
  });

  test("undoes the files first when the switch is on, or an undo is on its way", () => {
    expect(
      editUndoesFilesFirst({
        type: "offered",
        checked: true,
        problemKey: null,
      }),
    ).toBe(true);
    expect(
      editUndoesFilesFirst({
        type: "offered",
        checked: false,
        problemKey: null,
      }),
    ).toBe(false);
    expect(editUndoesFilesFirst({ type: "pending" })).toBe(true);
    expect(editUndoesFilesFirst({ type: "restored" })).toBe(false);
    expect(editUndoesFilesFirst({ type: "hidden" })).toBe(false);
  });

  test("says when the agent starts over from the chat's text", () => {
    expect(
      editRestartsConversation(
        readOf({ type: "none" }, null, {
          type: "restarts",
          reason: "previous_not_finished",
        }),
      ),
    ).toBe(true);
    expect(editRestartsConversation(readOf(AVAILABLE))).toBe(false);
    expect(editRestartsConversation(undefined)).toBe(false);
  });

  test("reads again while an undo or a stopped turn may still change the read", () => {
    const busy = readOf({ type: "unavailable", reason: "thread_busy" });
    expect(localFilesReadPollMs({ read: busy, followedForMs: 0 })).toBe(1000);
    expect(localFilesReadPollMs({ read: busy, followedForMs: 4000 })).toBe(
      4000,
    );
    expect(localFilesReadPollMs({ read: busy, followedForMs: 60_000 })).toBe(
      15_000,
    );
    expect(
      localFilesReadPollMs({
        read: readOf(AVAILABLE, undo("queued")),
        followedForMs: 0,
      }),
    ).toBe(1000);
    expect(
      localFilesReadPollMs({ read: readOf(AVAILABLE), followedForMs: 0 }),
    ).toBe(false);
    expect(localFilesReadPollMs({ read: undefined, followedForMs: 0 })).toBe(
      false,
    );
  });
});

describe("following an undo", () => {
  const follow = async ({
    asked,
    reads,
    open = true,
  }: {
    asked: LocalFilesUndoRequested;
    reads: readonly Result<ChatLocalFilesUndoRead, unknown>[];
    open?: boolean;
  }) => {
    let clock = 0;
    const waits: number[] = [];
    const pending = [...reads];
    const ended = await followLocalFilesUndo({
      now: () => clock,
      read: async () => pending.shift() ?? Result.err("no read left"),
      request: async () => Result.ok(asked),
      wait: async (ms) => {
        waits.push(ms);
        clock += ms;
        return open;
      },
    });
    return { ended: ended.isOk() ? ended.value : ended.error, waits };
  };

  test("ends restored once the computer put the folder back, reading at 1, 2 and 4 seconds", async () => {
    expect(
      await follow({
        asked: { type: "accepted", undo: undo("queued") },
        reads: [
          Result.ok(readOf(AVAILABLE, undo("sent"))),
          Result.err("offline for a moment"),
          Result.ok(readOf(AVAILABLE, undo("restored"))),
        ],
      }),
    ).toEqual({ ended: { type: "restored" }, waits: [1000, 1000, 2000] });
  });

  test("ends with the server's or the computer's refusal", async () => {
    expect(
      (
        await follow({
          asked: { type: "refused", reason: "folder_shared" },
          reads: [],
        })
      ).ended,
    ).toEqual({ type: "refused", reason: "folder_shared" });
    expect(
      (
        await follow({
          asked: { type: "accepted", undo: undo("sent") },
          reads: [Result.ok(readOf(AVAILABLE, undo("refused")))],
        })
      ).ended,
    ).toEqual({ type: "computer-refused", reason: "folder_busy" });
  });

  test("ends expired when the undo left the read, and with the read's reason when the files went", async () => {
    expect(
      (
        await follow({
          asked: { type: "accepted", undo: undo("queued") },
          reads: [Result.ok(readOf(AVAILABLE))],
        })
      ).ended,
    ).toEqual({ type: "expired" });
    expect(
      (
        await follow({
          asked: { type: "accepted", undo: undo("queued") },
          reads: [
            Result.ok(
              readOf({ type: "unavailable", reason: "desktop_offline" }),
            ),
          ],
        })
      ).ended,
    ).toEqual({ type: "refused", reason: "desktop_offline" });
  });

  test("stops following once the form closed", async () => {
    expect(
      (
        await follow({
          asked: { type: "accepted", undo: undo("queued") },
          reads: [],
          open: false,
        })
      ).ended,
    ).toEqual({ type: "abandoned" });
  });
});

describe("the undo's requests", () => {
  const PATH = `https://stella.example.com/v1/chat/threads/${THREAD_ID}/messages/${MESSAGE_ID}/local-files/undo`;

  test("reads what the edit does on the computer", async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    const fetch: Fetch = async (url, init) => {
      calls.push({ url, method: init?.method });
      return Response.json(readOf(AVAILABLE));
    };
    const read = await readLocalFilesUndo({
      fetch,
      messageId: MESSAGE_ID,
      source: sourceFor(fetch),
      threadId: THREAD_ID,
    });
    expect(read.isOk() ? read.value : read.error).toEqual(readOf(AVAILABLE));
    expect(calls).toEqual([{ url: PATH, method: "GET" }]);
  });

  test("asks for the undo, and takes a 409 as the reason it was refused", async () => {
    const answering =
      (status: number, body: unknown): Fetch =>
      async (url, init) => {
        expect({ url, method: init?.method }).toEqual({
          url: PATH,
          method: "POST",
        });
        return Response.json(body, { status });
      };
    const ask = async (fetch: Fetch) => {
      const asked = await requestLocalFilesUndo({
        fetch,
        messageId: MESSAGE_ID,
        source: sourceFor(fetch),
        threadId: THREAD_ID,
      });
      return asked.isOk() ? asked.value : asked.error._tag;
    };
    expect(
      await ask(
        answering(202, {
          status: "accepted",
          undo: undo("queued"),
          reason: null,
        }),
      ),
    ).toEqual({ type: "accepted", undo: undo("queued") });
    expect(
      await ask(
        answering(409, {
          status: "refused",
          undo: null,
          reason: "several_folders",
        }),
      ),
    ).toEqual({ type: "refused", reason: "several_folders" });
    // Any other refusal is a failure, shown as one.
    expect(
      await ask(answering(404, { code: "not_found", message: "Not found" })),
    ).toBe("ApiRequestError");
  });
});
