import { QueryClient } from "@tanstack/react-query";
import { afterAll, describe, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import {
  listenForSessionChange,
  signalSessionChange,
} from "@/lib/account/session-signal";
import { refreshAuthQueries } from "@/lib/auth-queries";

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async () => {
    await Promise.resolve();
    return Response.json(null);
  },
  { preconnect: () => undefined },
);

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const settle = async () => {
  await sleep(20);
};

/** What another tab would receive on the channel. */
const otherTabInbox = () => {
  const received: unknown[] = [];
  const channel = new BroadcastChannel("stella.session");
  channel.addEventListener("message", (event: MessageEvent<unknown>) => {
    received.push(event.data);
  });
  return {
    received,
    post: (message: unknown) => {
      const post = channel.postMessage.bind(channel);
      post(message);
    },
    close: () => {
      channel.close();
    },
  };
};

describe("the note between tabs", () => {
  test("another tab's note is heard", async () => {
    let heard = 0;
    const stop = listenForSessionChange(() => {
      heard += 1;
    });
    const otherTab = otherTabInbox();

    otherTab.post({ type: "session-changed", sender: "other-tab", nonce: "1" });
    await settle();

    expect(heard).toBe(1);
    stop();
    otherTab.close();
  });

  test("a tab's own notes and anything else on the channel are not", async () => {
    let heard = 0;
    const stop = listenForSessionChange(() => {
      heard += 1;
    });
    const otherTab = otherTabInbox();

    signalSessionChange();
    otherTab.post({ type: "something-else", sender: "other-tab" });
    await settle();

    expect(heard).toBe(0);
    // The other tab did get this tab's note.
    expect(otherTab.received).toContainEqual(
      expect.objectContaining({ type: "session-changed" }),
    );
    stop();
    otherTab.close();
  });

  test("every refresh of the session tells the other tabs", async () => {
    const otherTab = otherTabInbox();

    await refreshAuthQueries(new QueryClient());
    await settle();

    expect(otherTab.received).toHaveLength(1);
    otherTab.close();
  });
});

describe("without channels", () => {
  test("the note travels through storage, and a tab ignores its own", () => {
    const channels = globalThis.BroadcastChannel;
    const storage = new Map<string, string>();
    const events = new EventTarget();
    Object.assign(globalThis, {
      BroadcastChannel: undefined,
      window: Object.assign(events, {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => {
            storage.set(key, value);
          },
        },
      }),
    });
    let heard = 0;
    const stop = listenForSessionChange(() => {
      heard += 1;
    });

    signalSessionChange();
    const ownNote = storage.get("stella.session-signal") ?? null;
    expect(ownNote).not.toBeNull();
    events.dispatchEvent(
      Object.assign(new Event("storage"), {
        key: "stella.session-signal",
        newValue: ownNote,
      }),
    );
    events.dispatchEvent(
      Object.assign(new Event("storage"), {
        key: "stella.session-signal",
        newValue: JSON.stringify({
          type: "session-changed",
          sender: "other-tab",
          nonce: "2",
        }),
      }),
    );

    expect(heard).toBe(1);
    stop();
    Object.assign(globalThis, {
      BroadcastChannel: channels,
      window: undefined,
    });
  });
});
