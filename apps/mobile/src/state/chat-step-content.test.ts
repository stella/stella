import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  type ChatLocalRunStepContent,
  chatLocalRunStepContentWindow,
} from "@stll/api-contract/chat-local-run-step-content";
import { USER_FILE_URL_PREFIX } from "@stll/api-contract/user-file-url";
import { assertProperty } from "@stll/property-testing";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
  type StoredSession,
} from "@/connection/session";

import {
  hasMoreStepText,
  readStepContent,
  STEP_CONTENT_UNREAD,
  stepContentPath,
  type StepContentRead,
} from "./chat-step-content";

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

const THREAD_ID = "thread-1";
const CALL_ID = "run_8f0c:call/1";

/** A server that answers a step's reads, recording what was asked. */
const serving = (answer: (start: number) => ChatLocalRunStepContent | null) => {
  const asked: { start: number; authorization: string | null }[] = [];
  const answered: ChatLocalRunStepContent[] = [];
  const fetch: Fetch = async (input, init) => {
    const url = new URL(input);
    const start = Number(url.searchParams.get("start"));
    asked.push({
      start,
      authorization: new Headers(init?.headers).get("Authorization"),
    });
    expect(url.pathname).toBe(
      stepContentPath({ callId: CALL_ID, start, threadId: THREAD_ID }).split(
        "?",
      )[0] ?? "",
    );
    const body = answer(start);
    if (body === null) {
      return new Response(JSON.stringify({ message: "Unavailable" }), {
        status: 503,
      });
    }
    answered.push(body);
    return Response.json(body);
  };
  return { answered, asked, fetch, source: sourceFor(fetch) };
};

/** A stored command output, answered in windows of `limit` bytes. */
const textWindows = (text: string, limit: number) => {
  const bytes = new TextEncoder().encode(text);
  return (start: number): ChatLocalRunStepContent => {
    const window = chatLocalRunStepContentWindow(bytes, start, limit);
    return {
      state: "stored",
      kind: "command",
      totalBytes: bytes.byteLength,
      storedBytes: bytes.byteLength,
      start: window.start,
      text: new TextDecoder().decode(bytes.subarray(window.start, window.end)),
      nextStart: window.nextStart,
    };
  };
};

const readOnce = async (
  server: ReturnType<typeof serving>,
  read: StepContentRead,
) =>
  await readStepContent({
    callId: CALL_ID,
    fetch: server.fetch,
    read,
    source: server.source,
    threadId: THREAD_ID,
  });

describe("a coding agent's step content on the phone", () => {
  test("a text read window by window, each asked for after the last, rejoins to what is stored", async () => {
    await assertProperty(
      "a text read window by window, each asked for after the last, rejoins to what is stored",
      fc.asyncProperty(
        fc.string({ unit: "grapheme", minLength: 1 }),
        fc.integer({ min: 1, max: 64 }),
        async (text, limit) => {
          const server = serving(textWindows(text, limit));
          const bytes = new TextEncoder().encode(text).byteLength;
          let read = await readOnce(server, STEP_CONTENT_UNREAD);
          // Each window holds at least one byte, so this many reads suffice.
          for (let reads = 1; hasMoreStepText(read.view); reads += 1) {
            expect(reads).toBeLessThan(bytes);
            read = await readOnce(server, read);
          }
          expect(read).toEqual({
            type: "read",
            view: {
              status: "text",
              kind: "command",
              text,
              readBytes: bytes,
              storedBytes: bytes,
              totalBytes: bytes,
            },
            image: null,
          });
          // Each window is asked for where the one before it said to.
          expect(server.asked.map(({ start }) => start)).toEqual([
            0,
            ...server.answered.flatMap((answer) =>
              "nextStart" in answer && answer.nextStart !== null
                ? [answer.nextStart]
                : [],
            ),
          ]);
        },
      ),
    );
  });

  test("a read that fails keeps what was read, and reading again continues it", async () => {
    let down = false;
    const windows = textWindows("Clause 4 covers arrears.", 9);
    const server = serving((start) => (down ? null : windows(start)));
    const first = await readOnce(server, STEP_CONTENT_UNREAD);
    down = true;
    const failed = await readOnce(server, first);
    expect(failed).toMatchObject({
      type: "failed",
      view: first.view,
      error: { _tag: "ApiRequestError", status: 503 },
    });
    down = false;
    const continued = await readOnce(server, failed);
    expect(continued).toMatchObject({
      type: "read",
      view: { status: "text", text: "Clause 4 covers ar", readBytes: 18 },
    });
    expect(server.asked.map(({ start }) => start)).toEqual([0, 9, 9]);
  });

  test("a subagent's conversation is read whole, however long one entry is", async () => {
    const entry = (role: string, text: string) =>
      `${JSON.stringify({ role, text })}\n`;
    const kept = `${entry("prompt", "Summarize the lease. ".repeat(40))}${entry("report", "Clause 4.")}`;
    const bytes = new TextEncoder().encode(kept);
    const server = serving((start) => {
      const window = chatLocalRunStepContentWindow(bytes, start, 64);
      return {
        state: "stored",
        kind: "conversation",
        totalBytes: bytes.byteLength,
        storedBytes: bytes.byteLength,
        start: window.start,
        text: new TextDecoder().decode(
          bytes.subarray(window.start, window.end),
        ),
        nextStart: window.nextStart,
      };
    });
    // The first entry alone is longer than a window.
    expect(kept.indexOf("\n")).toBeGreaterThan(64);
    const read = await readOnce(server, STEP_CONTENT_UNREAD);
    expect(read).toMatchObject({
      type: "read",
      view: { status: "text", kind: "conversation", text: kept },
    });
    expect(hasMoreStepText(read.view)).toBe(false);
    expect(server.asked.length).toBeGreaterThan(1);
  });

  test("a step still arriving, or a first read that failed, is read again from its start", async () => {
    const answers: (ChatLocalRunStepContent | null)[] = [
      null,
      { state: "arriving" },
      { state: "not_stored" },
    ];
    const server = serving(() => answers.shift() ?? null);
    const failed = await readOnce(server, STEP_CONTENT_UNREAD);
    expect(failed).toMatchObject({
      type: "failed",
      view: { status: "unread" },
    });
    const arriving = await readOnce(server, failed);
    expect(arriving).toEqual({
      type: "read",
      view: { status: "answered", content: { state: "arriving" } },
      image: null,
    });
    const settled = await readOnce(server, arriving);
    expect(settled.view).toEqual({
      status: "answered",
      content: { state: "not_stored" },
    });
    expect(server.asked.map(({ start }) => start)).toEqual([0, 0, 0]);
  });

  test("a stored image loads from the API's chat file address with the session's token", async () => {
    const image = (fileId: string) =>
      ({
        state: "stored",
        kind: "image",
        totalBytes: 48_000,
        file: {
          url: `${USER_FILE_URL_PREFIX}${fileId}`,
          filename: "scan-12.png",
          mimeType: "image/png",
        },
      }) satisfies ChatLocalRunStepContent;
    const server = serving(() => image("file 7"));
    expect(await readOnce(server, STEP_CONTENT_UNREAD)).toEqual({
      type: "read",
      view: { status: "answered", content: image("file 7") },
      image: {
        uri: "https://stella.example.com/v1/user-files/file%207/content",
        headers: { Authorization: "Bearer access-0" },
      },
    });
    expect(server.asked).toEqual([
      { start: 0, authorization: "Bearer access-0" },
    ]);

    // An answer that names no file is the server's fault, never an image.
    const broken = serving(() => image(""));
    expect(await readOnce(broken, STEP_CONTENT_UNREAD)).toMatchObject({
      type: "failed",
      view: { status: "unread" },
      image: null,
      error: { _tag: "ApiRequestError" },
    });
  });

  test("a step is asked for by its thread and call, each encoded in the path", () => {
    expect(
      stepContentPath({ callId: CALL_ID, start: 65_536, threadId: "a/b" }),
    ).toBe(
      "/v1/chat/threads/a%2Fb/local-run-steps/run_8f0c%3Acall%2F1/content?start=65536",
    );
  });
});
