import { Result } from "better-result";

import { deviceStorage } from "@/lib/account/browser-storage";

/**
 * A note between the tabs of one browser that who is signed in may have
 * changed: after a sign-in, a change of organization or a sign-out. Each tab
 * that receives it reads its session again; the note carries nothing else.
 * It travels by `BroadcastChannel`, or through storage where a browser has
 * no channels.
 */
const SESSION_CHANNEL_NAME = "stella.session";
const SESSION_SIGNAL_KEY = "stella.session-signal";

type SessionSignal = { type: "session-changed"; sender: string; nonce: string };

/**
 * This tab, so it can tell its own notes from the others'. Built from
 * `getRandomValues`, which pages served over plain http also have.
 */
const TAB_ID = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
  byte.toString(16).padStart(2, "0"),
).join("");

const isSessionSignal = (value: unknown): value is SessionSignal =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  value.type === "session-changed" &&
  "sender" in value &&
  typeof value.sender === "string";

const openChannel = (): BroadcastChannel | null =>
  typeof BroadcastChannel === "undefined"
    ? null
    : Result.try(() => new BroadcastChannel(SESSION_CHANNEL_NAME)).unwrapOr(
        null,
      );

/** Tells the browser's other tabs to read their session again. */
export const signalSessionChange = (): void => {
  const signal: SessionSignal = {
    type: "session-changed",
    sender: TAB_ID,
    nonce: crypto.randomUUID(),
  };
  const channel = openChannel();
  if (channel !== null) {
    // A channel between tabs of one origin: it takes no target origin.
    const post = channel.postMessage.bind(channel);
    Result.try(() => {
      post(signal);
    }).unwrapOr(undefined);
    channel.close();
    return;
  }
  // Without channels, a changed entry reaches the other tabs as a storage
  // event; the nonce makes every note a change.
  const storage = deviceStorage("local");
  Result.try(() => {
    storage.setItem(SESSION_SIGNAL_KEY, JSON.stringify(signal));
  }).unwrapOr(undefined);
};

/** Whether `value` is another tab's note. */
const fromAnotherTab = (value: unknown) =>
  isSessionSignal(value) && value.sender !== TAB_ID;

/**
 * Calls `onSignal` for each note another tab sends; a tab's own notes are
 * ignored. Returns the unsubscribe.
 */
export const listenForSessionChange = (onSignal: () => void) => {
  const channel = openChannel();
  if (channel !== null) {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (fromAnotherTab(event.data)) {
        onSignal();
      }
    };
    channel.addEventListener("message", onMessage);
    return () => {
      channel.removeEventListener("message", onMessage);
      channel.close();
    };
  }
  if (typeof window === "undefined") {
    return () => undefined;
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== SESSION_SIGNAL_KEY || event.newValue === null) {
      return;
    }
    const newValue = event.newValue;
    const parsed = Result.try((): unknown => JSON.parse(newValue)).unwrapOr(
      null,
    );
    if (fromAnotherTab(parsed)) {
      onSignal();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("storage", onStorage);
  };
};
