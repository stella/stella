import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  chatRunsChangedRealtimeEvent,
  newNotificationRealtimeEvent,
} from "@stll/api-contract";
import { SSE_HEARTBEAT_FRAME } from "@stll/api-contract/sse-heartbeat";

import {
  createAccessTokenSource,
  createSessionStore,
  type StoredSession,
} from "@/connection/session";

import type { StreamFetch } from "./chat-stream";
import { readUserEvents } from "./user-events";

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

const sourceFor = () => {
  const store = createSessionStore({
    read: async () => SESSION,
    write: async () => {},
    prepareClear: async () => {},
    clear: async () => {},
  });
  return createAccessTokenSource({
    fetch: async () =>
      Response.json({
        access_token: "access-1",
        expires_in: 3600,
        refresh_token: "refresh-2",
        token_type: "Bearer",
      }),
    initialAccess: { token: "access-0", expiresAt: Number.MAX_SAFE_INTEGER },
    now: () => 0,
    session: SESSION,
    store,
    generation: store.generation(),
  });
};

const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

const bodyOf = (chunks: readonly string[]) => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
};

describe("the person's event stream", () => {
  test("opens with the bearer token, then hands over the events it knows", async () => {
    const seen: string[] = [];
    const requests: { url: string; headers: Record<string, string> }[] = [];
    const fetch: StreamFetch = async (url, init) => {
      requests.push({ url, headers: init.headers });
      return new Response(
        bodyOf([
          SSE_HEARTBEAT_FRAME,
          frame(chatRunsChangedRealtimeEvent()),
          frame({ type: "something-newer" }),
          "data: not json\n\n",
          frame(newNotificationRealtimeEvent()),
        ]),
      );
    };
    const read = await readUserEvents({
      fetch,
      onEvent: ({ type }) => {
        seen.push(type);
      },
      onOpen: () => {
        seen.push("open");
      },
      signal: new AbortController().signal,
      source: sourceFor(),
    });
    expect(Result.isOk(read)).toBe(true);
    expect(seen).toEqual(["open", "chat-runs.changed", "new-notification"]);
    expect(requests).toEqual([
      {
        url: "https://stella.example.com/v1/notifications/events",
        headers: {
          Accept: "text/event-stream",
          Authorization: "Bearer access-0",
        },
      },
    ]);
  });

  test("a refused stream is a failure carrying the status, and never opens", async () => {
    let opened = false;
    const fetch: StreamFetch = async () =>
      new Response("Forbidden", { status: 403 });
    const read = await readUserEvents({
      fetch,
      onEvent: () => {},
      onOpen: () => {
        opened = true;
      },
      signal: new AbortController().signal,
      source: sourceFor(),
    });
    expect(
      Result.isError(read) && read.error._tag === "ApiRequestError"
        ? read.error.status
        : read,
    ).toBe(403);
    expect(opened).toBe(false);
  });

  test("ends without an error when the app closes it", async () => {
    const controller = new AbortController();
    // Like a platform fetch, the body errors once its request is aborted.
    const fetch: StreamFetch = async (_url, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            init.signal.addEventListener("abort", () => {
              stream.error(init.signal.reason);
            });
          },
        }),
      );
    const read = await readUserEvents({
      fetch,
      onEvent: () => {},
      onOpen: () => {
        controller.abort();
      },
      signal: controller.signal,
      source: sourceFor(),
    });
    expect(Result.isOk(read)).toBe(true);
  });
});
