import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CHAT_TURN_ID_HEADER } from "@stll/api-contract";
import {
  CHAT_COMMAND_ERROR_CODE,
  CHAT_COMMAND_ID_HEADER,
} from "@stll/api-contract/chat-command";

import {
  createChatRuntime,
  resetChatRequestStateForTests,
  sendThreadChatMessageUntilAccepted,
} from "@/features/chat/chat-runtime";
import type { ChatRuntime } from "@/features/chat/chat-runtime";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";

// A member sends a message and the connection drops before the server's
// answer arrives. The page sends it again under the same command id; the
// server took the first attempt, so it answers the retry with that turn. The
// page must treat it as sent and follow the turn, never report a failure.

const THREAD_ID = toChatThreadId("thread-command-replay");
const TURN_ID = "018f0000-0000-7000-8000-0000000000f1";
const MESSAGE_ID = toSafeId<"chatMessage">(
  "018f0000-0000-7000-8000-0000000000f2",
);

type Posted = { action: string; commandId: string | null; method: string };

const requestAction = (input: RequestInfo | URL): string => {
  const url = new URL(input instanceof Request ? input.url : input);
  return url.pathname.split("/").at(-1) ?? "";
};

/** The API: the first send's response is lost, the retry is a replay. */
const installServer = (): Posted[] => {
  const posted: Posted[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      await Promise.resolve();
      posted.push({
        action: requestAction(input),
        commandId: new Headers(init?.headers).get(CHAT_COMMAND_ID_HEADER),
        method: init?.method ?? "GET",
      });
      if (posted.length === 1) {
        throw new TypeError("Failed to fetch");
      }
      return Response.json(
        {
          code: CHAT_COMMAND_ERROR_CODE.replayed,
          message: "The command was accepted earlier; join its turn",
        },
        { headers: { [CHAT_TURN_ID_HEADER]: TURN_ID }, status: 409 },
      );
    },
    { preconnect: () => undefined },
  );
  return posted;
};

const openPage = () => {
  const errors: Error[] = [];
  let reloads = 0;
  const runtime = createChatRuntime({
    activeTurnId: null,
    context: undefined,
    initialMessages: [],
    key: { scope: "global", threadId: THREAD_ID },
    onError: (error) => {
      errors.push(error);
    },
    onFinish: () => undefined,
    reloadThread: () => {
      reloads += 1;
    },
  });
  return { errors, reloads: () => reloads, runtime };
};

/** Resolves once the page is no longer working on its request. */
const settle = async (runtime: ChatRuntime) => {
  const idle = () => !runtime.getSnapshot().isLoading;
  if (idle()) {
    return;
  }
  const done = Promise.withResolvers<undefined>();
  const unsubscribe = runtime.subscribe(() => {
    if (idle()) {
      done.resolve(undefined);
    }
  });
  try {
    await done.promise;
  } finally {
    unsubscribe();
  }
};

const previousFetch = globalThis.fetch;

describe("a send whose response was lost and whose retry is a replay", () => {
  beforeEach(() => {
    resetChatRequestStateForTests();
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  test("is sent, shows no error, and the page reads the thread to follow its turn", async () => {
    const posted = installServer();
    const page = openPage();
    const unsubscribe = page.runtime.subscribe(() => undefined);
    try {
      const acceptance = await sendThreadChatMessageUntilAccepted(
        page.runtime,
        { content: "Summarise the lease", id: MESSAGE_ID },
      );
      await settle(page.runtime);

      expect(acceptance).toEqual({ status: "accepted" });
      // One member action: two attempts under one command id.
      expect(posted.map(({ action, method }) => `${method} ${action}`)).toEqual(
        ["POST chat", "POST chat"],
      );
      expect(posted[0]?.commandId).not.toBeNull();
      expect(posted[1]?.commandId).toBe(posted[0]?.commandId ?? "");
      // The thread as stored holds the turn; the page reads it again.
      expect(page.reloads()).toBe(1);
      expect(page.runtime.getSnapshot()).toMatchObject({
        error: undefined,
        turnAbandoned: true,
      });
      expect(page.errors).toEqual([]);
    } finally {
      unsubscribe();
    }
  });
});
