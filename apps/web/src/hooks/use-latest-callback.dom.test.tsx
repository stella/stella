import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

declare global {
  // Set by the testing library; off while a store update runs outside `act`.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// A DOM for this file only: the hook's contract is about when a committed
// render reaches the callback, which needs React to render and commit.
GlobalRegistrator.register({ url: "http://localhost:3000/law" });

const React = await import("react");
const { render } = await import("@testing-library/react");
const { useMountEffect } = await import("@/hooks/use-effect");
const { useLatestCallback } = await import("@/hooks/use-latest-callback");

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** A store a component reads through `useSyncExternalStore`, the way the
 *  chat page reads the runtime's snapshot while a response streams. */
const createStore = () => {
  const listeners = new Set<() => void>();
  let value = 0;
  return {
    getSnapshot: () => value,
    set: (next: number) => {
      value = next;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

describe("useLatestCallback", () => {
  // The chat composer keeps one `handleSubmit` across a stream's renders and
  // reads the messages through it. Every stream-driven render comes from an
  // external store, which React renders synchronously and whose passive
  // effects it flushes in the same commit, so a submit that follows such a
  // render never sees the render before it.
  test("reads the value of a store-driven render before the next task", async () => {
    const store = createStore();
    let read: (() => number) | undefined;
    // Handed out once, as a page hands its submit handler to the composer.
    const Page = ({ onReady }: { onReady: (read: () => number) => void }) => {
      const value = React.useSyncExternalStore(
        store.subscribe,
        store.getSnapshot,
        store.getSnapshot,
      );
      const readValue = useLatestCallback(() => value);
      useMountEffect(() => {
        onReady(readValue);
      });
      return null;
    };
    render(
      <Page
        onReady={(handler) => {
          read = handler;
        }}
      />,
    );
    expect(read?.()).toBe(0);

    // Outside `act`, as a streamed chunk arrives: nothing flushes for the
    // test's sake.
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      store.set(1);
      await sleep(0);
    } finally {
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    }

    expect(read?.()).toBe(1);
  });
});
