import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { act } = await import("react");
const { cleanup, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { useUserEventsSSE } = await import("./user-events-sse");

/** A stream the test drives: it opens, drops and delivers on command. */
class ScriptedEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: ScriptedEventSource[] = [];
  readyState = ScriptedEventSource.CONNECTING;
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
    ScriptedEventSource.instances.push(this);
  }

  open() {
    this.readyState = ScriptedEventSource.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  /** The browser lost the connection and is retrying on its own. */
  drop() {
    this.readyState = ScriptedEventSource.CONNECTING;
    this.dispatchEvent(new Event("error"));
  }

  deliver(data: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(data) }),
    );
  }

  close() {
    this.readyState = ScriptedEventSource.CLOSED;
  }
}

const originalEventSource = globalThis.EventSource;

beforeEach(() => {
  ScriptedEventSource.instances = [];
  globalThis.EventSource = ScriptedEventSource as unknown as typeof EventSource;
});
afterEach(() => {
  cleanup();
  globalThis.EventSource = originalEventSource;
});
afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

const mountStream = () => {
  const calls = { events: [] as string[], resyncs: 0 };
  const Subscriber = () => {
    useUserEventsSSE("organization_firm", {
      onEvent: (event) => {
        calls.events.push(event.type);
        return [];
      },
      onResync: () => {
        calls.resyncs += 1;
        return [];
      },
    });
    return null;
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Subscriber />
    </QueryClientProvider>,
  );
  const stream = ScriptedEventSource.instances.at(-1);
  if (stream === undefined) {
    throw new Error("The hook opened no stream");
  }
  return { calls, stream };
};

test("the first open re-reads nothing: the queries were just fetched", () => {
  const { calls, stream } = mountStream();
  act(() => {
    stream.open();
  });
  expect(calls.resyncs).toBe(0);
});

test("every reopen after a drop re-reads what the stream keeps fresh", () => {
  const { calls, stream } = mountStream();
  act(() => {
    stream.open();
    stream.drop();
    stream.open();
    stream.drop();
    stream.open();
  });
  expect(calls.resyncs).toBe(2);
});

test("a delivered event reaches the handler and an unknown one does not", () => {
  const { calls, stream } = mountStream();
  act(() => {
    stream.open();
    stream.deliver({ type: "new-notification", data: null });
    stream.deliver({ type: "not-a-user-event", data: null });
  });
  expect(calls.events).toEqual(["new-notification"]);
});
