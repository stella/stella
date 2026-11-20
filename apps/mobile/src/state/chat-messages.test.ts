import { describe, expect, test } from "bun:test";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
  type StoredSession,
} from "@/connection/session";

import {
  messagesQuery,
  prependOlderPage,
  readChatThread,
  readOlderChatMessages,
  sentEntry,
  steeringAfterPageRead,
  toChatEntry,
  withLatestPage,
} from "./chat-messages";
import type { ChatEntry } from "./chat-messages";

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

const CREATED_AT = "2026-10-20T10:00:00.000Z";

describe("what a thread shows of a stored message", () => {
  test("joins its text parts and sums up the steps before them by their titles", () => {
    expect(
      toChatEntry({
        id: "m1",
        role: "assistant",
        createdAt: CREATED_AT,
        parts: [
          { type: "thinking", content: "Check the register first." },
          {
            type: "tool-call",
            name: "discover_tools",
            arguments: "{}",
            state: "complete",
            output: { tools: [] },
          },
          {
            type: "tool-call",
            name: "execute_typescript",
            arguments: "{}",
            state: "complete",
            output: { success: true, result: [] },
          },
          { type: "tool-result", toolCallId: "c2", content: "{}" },
          {
            type: "tool-call",
            name: "load-skill",
            arguments: "{}",
            state: "error",
          },
          { type: "text", content: "First.  " },
          { type: "text", content: "Second." },
          { type: "image", source: { type: "url", value: "x" } },
        ],
      }),
    ).toEqual({
      id: "m1",
      role: "assistant",
      createdAt: CREATED_AT,
      text: "First.\n\nSecond.",
      blocks: [
        {
          type: "steps",
          key: "0",
          // A skill that failed to load is not news to the reader.
          steps: [
            { type: "reasoning", text: "Check the register first." },
            { type: "tool", label: "discover_tools", status: "done" },
            { type: "tool", label: "execute_typescript", status: "done" },
          ],
          // Finding a tool's signature and a script that read nothing are
          // no lookups: the run counts its steps.
          summary: [{ phrase: "steps", count: 3 }],
        },
        { type: "text", key: "5", markdown: "First.\n\nSecond." },
      ],
      files: [{ name: "", mimeType: "" }],
      drafts: [],
      contextNotice: null,
    });
  });

  test("keeps a finished web search as a step, having no sources tray", () => {
    expect(
      toChatEntry({
        id: "m4",
        role: "assistant",
        createdAt: CREATED_AT,
        parts: [
          {
            type: "tool-call",
            name: "web_search",
            arguments: "{}",
            state: "complete",
            output: { results: [] },
          },
          { type: "text", content: "Found it." },
        ],
      })?.blocks,
    ).toEqual([
      {
        type: "steps",
        key: "0",
        steps: [{ type: "tool", label: "web_search", status: "done" }],
        summary: [{ phrase: "searchedWeb", count: 1 }],
      },
      { type: "text", key: "1", markdown: "Found it." },
    ]);
  });

  test("names the files the person attached, and shows a message of files alone", () => {
    const parts = [
      {
        type: "document",
        source: {
          type: "url",
          value: "userfile://f1",
          mimeType: "application/pdf",
        },
        metadata: { filename: "Lease.pdf" },
      },
      {
        type: "image",
        source: {
          type: "url",
          value: "userfile://f2",
          mimeType: "image/png",
        },
        metadata: { filename: "Stamp.png" },
      },
    ];
    expect(
      toChatEntry({ id: "m2", role: "user", createdAt: CREATED_AT, parts }),
    ).toEqual({
      id: "m2",
      role: "user",
      createdAt: CREATED_AT,
      text: "",
      blocks: [],
      files: [
        { name: "Lease.pdf", mimeType: "application/pdf" },
        { name: "Stamp.png", mimeType: "image/png" },
      ],
      drafts: [],
      contextNotice: null,
      // Kept as stored, so an edit sends the files back as they are.
      parts,
    });
  });

  test("keeps no parts on an answer, which cannot be edited", () => {
    expect(
      toChatEntry({
        id: "a2",
        role: "assistant",
        createdAt: CREATED_AT,
        parts: [{ type: "text", content: "Done." }],
      })?.parts,
    ).toBeUndefined();
  });

  test("draws a message sent from here with its files' names, not their bytes", () => {
    expect(
      sentEntry({
        createdAt: CREATED_AT,
        draft: {
          text: "Summarise this",
          files: [
            {
              name: "Lease.pdf",
              mimeType: "application/pdf",
              dataUrl: "data:application/pdf;base64,JVBERg==",
            },
          ],
        },
        messageId: "m3",
      }),
    ).toEqual({
      id: "m3",
      role: "user",
      createdAt: CREATED_AT,
      text: "Summarise this",
      blocks: [],
      files: [{ name: "Lease.pdf", mimeType: "application/pdf" }],
      drafts: [],
      contextNotice: null,
    });
  });

  test("says what an answer's context left out, and nothing of a notice it does not know", () => {
    const answer = (metadata: unknown) =>
      toChatEntry({
        id: "m5",
        role: "assistant",
        createdAt: "2026-10-20T10:00:00.000Z",
        parts: [{ type: "text", content: "Done." }],
        metadata,
      })?.contextNotice;
    expect(answer({ contextNotice: { type: "session-not-resumed" } })).toEqual({
      type: "session-not-resumed",
    });
    expect(answer({ contextNotice: { type: "history-trimmed" } })).toEqual({
      type: "history-trimmed",
    });
    expect(
      answer({ contextNotice: { type: "from-a-newer-server" } }),
    ).toBeNull();
    expect(answer(undefined)).toBeNull();
  });

  test("names the model an answer ran on only when the harness rerouted it", () => {
    const answer = (metadata: unknown) =>
      toChatEntry({
        id: "m6",
        role: "assistant",
        createdAt: "2026-10-20T10:00:00.000Z",
        parts: [{ type: "text", content: "Done." }],
        metadata,
      })?.ranOnModel;
    expect(
      answer({ localRunModel: { requested: "gpt-5.5", ran: "gpt-5.4" } }),
    ).toBe("gpt-5.4");
    expect(
      answer({ localRunModel: { requested: "gpt-5.5", ran: "gpt-5.5" } }),
    ).toBeUndefined();
    expect(answer({ localRunModel: { ran: "gpt-5.4" } })).toBeUndefined();
    expect(answer(undefined)).toBeUndefined();
  });

  test("leaves out system messages and messages with nothing to draw", () => {
    expect(
      toChatEntry({
        id: "s",
        role: "system",
        createdAt: CREATED_AT,
        parts: [{ type: "text", content: "instructions" }],
      }),
    ).toBeUndefined();
    expect(
      toChatEntry({
        id: "e",
        role: "user",
        createdAt: CREATED_AT,
        parts: [{ type: "thinking", content: "private reasoning" }],
      }),
    ).toBeUndefined();
  });
});

describe("reading a thread", () => {
  test("reads the latest page, then the page before its cursor", async () => {
    const calls: string[] = [];
    const fetch: Fetch = async (input) => {
      calls.push(input);
      return Response.json({
        messages: [
          {
            id: input.includes("older") ? "m0" : "m1",
            role: "user",
            createdAt: CREATED_AT,
            edited: false,
            revision: 1,
            parts: [{ type: "text", content: "Hello" }],
          },
        ],
        olderCursor: input.includes("older") ? null : "cursor/1",
        // The rest of the thread's state rides along and is ignored.
        activeTurnId: null,
        threadExists: true,
      });
    };
    const source = sourceFor(fetch);
    const latest = await readChatThread({
      fetch,
      matterId: "matter 1",
      source,
      threadId: "t 1",
    });
    expect(latest.isOk() ? latest.value.olderCursor : latest.error._tag).toBe(
      "cursor/1",
    );
    const older = await readOlderChatMessages({
      before: "cursor/1",
      fetch,
      matterId: "matter 1",
      source,
      threadId: "t 1",
    });
    expect(
      older.isOk() ? older.value.entries.map(({ id }) => id) : older.error._tag,
    ).toEqual(["m0"]);
    expect(calls).toEqual([
      "https://stella.example.com/v1/chat/threads/t%201/messages?workspaceId=matter%201",
      "https://stella.example.com/v1/chat/threads/t%201/messages/older?before=cursor%2F1&workspaceId=matter%201",
    ]);
  });

  test("says whether the thread has sent anonymized text", async () => {
    const pageFor =
      (usedAnonymization?: boolean): Fetch =>
      async () =>
        Response.json({
          messages: [],
          olderCursor: null,
          activeTurnId: null,
          ...(usedAnonymization === undefined ? {} : { usedAnonymization }),
        });
    const read = async (fetch: Fetch) => {
      const page = await readChatThread({
        fetch,
        matterId: undefined,
        source: sourceFor(fetch),
        threadId: "t1",
      });
      return page.isOk() ? page.value.usedAnonymization : page.error._tag;
    };
    expect(await read(pageFor(true))).toBe(true);
    expect(await read(pageFor(false))).toBe(false);
    // A server from before the field reads as a thread that never anonymized.
    expect(await read(pageFor(undefined))).toBe(false);
  });

  test("says whether the turn it waits on or runs takes a message mid-turn", async () => {
    const pageFor =
      (activeTurnSteering?: string): Fetch =>
      async () =>
        Response.json({
          messages: [],
          olderCursor: null,
          activeTurnId: "turn-1",
          ...(activeTurnSteering === undefined ? {} : { activeTurnSteering }),
        });
    const read = async (fetch: Fetch) => {
      const page = await readChatThread({
        fetch,
        matterId: undefined,
        source: sourceFor(fetch),
        threadId: "t1",
      });
      return page.isOk() ? page.value.activeTurnSteering : page.error._tag;
    };
    expect(await read(pageFor("steerable"))).toBe("steerable");
    expect(await read(pageFor("not_steerable"))).toBe("not_steerable");
    // A server from before the field: the turn takes none, so nothing waits
    // on a guess.
    expect(await read(pageFor(undefined))).toBe("not_steerable");
  });

  test("a refused answer leaves the waiting turn steerable as the page reads it again", () => {
    // Answering opened a turn that takes nothing; the server refused it
    // before it streamed, so only the page says the wait takes a message.
    expect(
      steeringAfterPageRead({
        page: "steerable",
        shown: "not_steerable",
        streamOpen: false,
      }),
    ).toBe("steerable");
    // An open stream says it for its own turn.
    expect(
      steeringAfterPageRead({
        page: "steerable",
        shown: "not_steerable",
        streamOpen: true,
      }),
    ).toBe("not_steerable");
  });

  test("a global thread is read without a matter", () => {
    expect(messagesQuery({ matterId: undefined })).toBe("");
    expect(messagesQuery({ before: "c", matterId: undefined })).toBe(
      "?before=c",
    );
  });

  test("a re-read latest page drops what the server no longer holds", () => {
    const entry = (id: string): ChatEntry => ({
      id,
      role: "user",
      createdAt: CREATED_AT,
      text: id,
      blocks: [],
      files: [],
      drafts: [],
      contextNotice: null,
    });
    const ids = ({
      entries,
      standalone,
    }: ReturnType<typeof withLatestPage>) => ({
      ids: entries.map(({ id }) => id),
      standalone,
    });
    // Another device edited u2: a2 and u3 left the thread.
    expect(
      ids(
        withLatestPage(
          ["u0", "a0", "u1", "a1", "u2", "a2", "u3"].map(entry),
          ["u1", "a1", "u2", "a4"].map(entry),
        ),
      ),
    ).toEqual({ ids: ["u0", "a0", "u1", "a1", "u2", "a4"], standalone: false });
    // Nothing loaded is known to come before the page: it stands alone.
    expect(
      ids(withLatestPage(["u1", "a1", "u2"].map(entry), [entry("u9")])),
    ).toEqual({ ids: ["u9"], standalone: true });
    expect(ids(withLatestPage([entry("u1")], []))).toEqual({
      ids: [],
      standalone: true,
    });
  });

  test("an older page goes in front, without a message twice", () => {
    const entry = (id: string): ChatEntry => ({
      id,
      role: "user",
      createdAt: CREATED_AT,
      text: id,
      blocks: [],
      files: [],
      drafts: [],
      contextNotice: null,
    });
    expect(
      prependOlderPage(
        [entry("c"), entry("d")],
        [entry("a"), entry("b"), entry("c")],
      ).map(({ id }) => id),
    ).toEqual(["a", "b", "c", "d"]);
  });
});

describe("an answer whose turn failed", () => {
  const LOCAL = {
    kind: "local",
    harness: "codex",
    model: "gpt-5-codex",
    approvals: "ask",
    reasoningEffort: null,
  } as const;
  const ASKED = {
    id: "u1",
    role: "user",
    createdAt: CREATED_AT,
    parts: [{ type: "text", content: "Which leases end this year?" }],
  };
  const failedAnswer = (error: unknown) => ({
    id: "a1",
    role: "assistant",
    createdAt: CREATED_AT,
    parts: [],
    metadata: { turnOutcome: { type: "failed", error } },
  });
  const latestPage = async (
    messages: readonly unknown[],
    runTarget?: unknown,
  ) => {
    const fetch: Fetch = async () =>
      Response.json({
        messages,
        olderCursor: null,
        activeTurnId: null,
        ...(runTarget === undefined ? {} : { runTarget }),
      });
    const page = await readChatThread({
      fetch,
      matterId: undefined,
      source: sourceFor(fetch),
      threadId: "t1",
    });
    return page.isOk() ? page.value : undefined;
  };

  test("draws with the reason it failed, though it has no parts, and a kind this build does not know reads as unknown", () => {
    for (const [error, failure] of [
      ["local_runner_no_computer", "local_runner_no_computer"],
      ["a_kind_from_a_newer_server", "unknown"],
      [undefined, "unknown"],
    ] as const) {
      expect(toChatEntry(failedAnswer(error))).toMatchObject({
        id: "a1",
        role: "assistant",
        blocks: [],
        failure,
      });
    }
    // A turn that did not fail still leaves out an answer with nothing to draw.
    expect(
      toChatEntry({
        ...failedAnswer("unknown"),
        metadata: { turnOutcome: { type: "completed" } },
      }),
    ).toBeUndefined();
  });

  test("the latest page offers to answer the person's message again, on the thread's computer", async () => {
    const page = await latestPage(
      [ASKED, failedAnswer("local_runner_no_computer")],
      LOCAL,
    );
    expect(page?.entries.map(({ id, failure }) => ({ id, failure }))).toEqual([
      { id: "u1", failure: undefined },
      { id: "a1", failure: "local_runner_no_computer" },
    ]);
    expect(page?.retry).toEqual({
      answerId: "a1",
      messageId: "u1",
      parts: ASKED.parts,
      runTarget: LOCAL,
    });
    // A thread on stella's own models names no target.
    expect(
      (
        await latestPage([ASKED, failedAnswer("provider_unavailable")], {
          kind: "cloud",
        })
      )?.retry?.runTarget,
    ).toBeUndefined();
  });

  test("no retry is offered once a later answer did not fail", async () => {
    const answered = {
      id: "a2",
      role: "assistant",
      createdAt: CREATED_AT,
      parts: [{ type: "text", content: "Two of them." }],
      metadata: { turnOutcome: { type: "completed" } },
    };
    expect((await latestPage([ASKED, answered]))?.retry).toBeNull();
    expect(
      (await latestPage([failedAnswer("unknown"), ASKED, answered]))?.retry,
    ).toBeNull();
  });
});
