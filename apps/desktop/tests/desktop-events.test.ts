import { describe, expect, mock, test } from "bun:test";

const listenMock = mock();

await mock.module("@tauri-apps/api/event", () => ({ listen: listenMock }));

const { subscribeDesktopEvent } = await import("../src/shared/desktop-events");

const EVENT = "clipboard-history-changed";
const noop = () => {};

/** Lets the subscription promise and any teardown promise settle. */
const settle = async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
};

describe("subscribeDesktopEvent", () => {
  test("reports a subscription that never comes up", async () => {
    listenMock.mockRejectedValue(new Error("event.listen not allowed"));
    const onError = mock(noop);

    subscribeDesktopEvent({ event: EVENT, handler: noop, onError });
    await settle();

    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("reports a teardown that fails", async () => {
    const unlisten = mock(async () => {
      await Promise.reject(new Error("window is gone"));
    });
    listenMock.mockResolvedValue(unlisten);
    const onError = mock(noop);

    const stopListening = subscribeDesktopEvent({
      event: EVENT,
      handler: noop,
      onError,
    });
    await settle();
    stopListening();
    await settle();

    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("runs onSubscribed once the subscription is live", async () => {
    listenMock.mockResolvedValue(mock(noop));
    const onSubscribed = mock(noop);

    subscribeDesktopEvent({
      event: EVENT,
      handler: noop,
      onError: mock(noop),
      onSubscribed,
    });

    expect(onSubscribed).not.toHaveBeenCalled();
    await settle();
    expect(onSubscribed).toHaveBeenCalledTimes(1);
  });

  test("unsubscribes when cancelled before the subscription resolves", async () => {
    const unlisten = mock(noop);
    listenMock.mockResolvedValue(unlisten);
    const onSubscribed = mock(noop);

    const stopListening = subscribeDesktopEvent({
      event: EVENT,
      handler: noop,
      onError: mock(noop),
      onSubscribed,
    });
    stopListening();
    await settle();

    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(onSubscribed).not.toHaveBeenCalled();
  });
});
