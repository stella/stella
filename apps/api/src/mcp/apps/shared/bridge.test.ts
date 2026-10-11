import { afterEach, describe, expect, test } from "bun:test";

import { CASE_LAW_RESULTS_APP } from "../manifest";
import { createPresentationBridge } from "./bridge";

type JsonRpcMessage = Parameters<Window["postMessage"]>[0];

class TestWindow {
  readonly listeners = new Set<(event: MessageEvent) => void>();
  readonly messages: JsonRpcMessage[] = [];
  innerWidth = 640;

  addEventListener(_type: "message", listener: (event: MessageEvent) => void) {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent) => void,
  ) {
    this.listeners.delete(listener);
  }

  dispatch(data: unknown, source: MessageEventSource) {
    for (const listener of this.listeners) {
      listener(new MessageEvent("message", { data, source }));
    }
  }

  postMessage(message: JsonRpcMessage) {
    this.messages.push(message);
  }
}

const documentElement = {
  lang: "",
  dir: "",
  classList: { toggle: () => {} },
  style: {
    height: "",
    colorScheme: "",
    setProperty: () => {},
  },
  setAttribute: () => {},
  getBoundingClientRect: () => ({ height: 240 }),
};
const documentStub = {
  documentElement,
  body: {},
  title: "",
  getElementById: () => null,
};

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalResizeObserver = globalThis.ResizeObserver;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

const response = (id: string | number, result: unknown) => ({
  jsonrpc: "2.0" as const,
  id,
  result,
});
const notification = (method: string, params: unknown) => ({
  jsonrpc: "2.0" as const,
  method,
  params,
});
const TOOL_CAPABILITIES = { serverTools: {} };

const setup = () => {
  const eventWindow = new TestWindow();
  const source = new MessageChannel().port1;
  Object.assign(eventWindow, { parent: source });
  source.postMessage = eventWindow.postMessage.bind(eventWindow);
  const resizeCallbacks: (() => void)[] = [];
  Object.assign(globalThis, {
    window: eventWindow,
    document: documentStub,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    ResizeObserver: class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(() => callback([], this));
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  const bridge = createPresentationBridge({
    manifest: CASE_LAW_RESULTS_APP,
    parse: (payload) =>
      typeof payload === "object" && payload !== null ? payload : undefined,
  });
  const receive = (
    message: unknown,
    eventSource: MessageEventSource = source,
  ) => eventWindow.dispatch(message, eventSource);
  const nextRequest = (method: string) => {
    const found = eventWindow.messages.find(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "method" in message &&
        message.method === method,
    );
    if (
      found === undefined ||
      typeof found !== "object" ||
      found === null ||
      !("id" in found)
    ) {
      throw new TypeError(
        `Expected ${method} request: ${JSON.stringify(eventWindow.messages)}`,
      );
    }
    return found;
  };
  const connect = async (
    capabilities: Record<string, unknown> = TOOL_CAPABILITIES,
    transport: "default" | "injected" = "injected",
  ) => {
    const connecting =
      transport === "default"
        ? bridge.connect()
        : bridge.connect({ target: window, source });
    await Bun.sleep(0);
    const initialize = nextRequest("ui/initialize");
    receive(
      response(initialize.id, {
        protocolVersion: "2026-01-26",
        hostInfo: { name: "test host", version: "1" },
        hostCapabilities: capabilities,
        hostContext: {
          locale: "en",
          availableDisplayModes: ["inline", "fullscreen"],
        },
      }),
      source,
    );
    await connecting;
  };
  return {
    bridge,
    target: eventWindow,
    receive,
    nextRequest,
    connect,
    resizeCallbacks,
  };
};

afterEach(() => {
  Object.assign(globalThis, {
    window: originalWindow,
    document: originalDocument,
    ResizeObserver: originalResizeObserver,
    requestAnimationFrame: originalRequestAnimationFrame,
  });
});

describe("MCP app bridge protocol", () => {
  test("connects through the default browser transport without an argument", async () => {
    const host = setup();
    await host.connect(TOOL_CAPABILITIES, "default");
    expect(host.bridge.supportsTools()).toBeTrue();
    expect(host.bridge.getSnapshot().context.locale).toBe("en");
  });

  test("connects through an injected target and source pair", async () => {
    const host = setup();
    // @ts-expect-error An injected transport requires its source as well as its target.
    const partial = { target: window } satisfies NonNullable<
      Parameters<typeof host.bridge.connect>[0]
    >;
    expect(partial.target).toBe(window);
    await host.connect();
    expect(host.bridge.supportsTools()).toBeTrue();
    expect(host.bridge.getSnapshot().context.locale).toBe("en");
  });

  test("connects, reports size, and applies host context and theme updates", async () => {
    const host = setup();
    let publications = 0;
    const unsubscribe = host.bridge.subscribe(() => {
      publications += 1;
    });
    await host.connect();

    expect(
      host.target.messages.some(
        (message) =>
          "method" in message &&
          message.method === "ui/notifications/initialized",
      ),
    ).toBeTrue();
    expect(host.target.messages).toContainEqual(
      notification("ui/notifications/size-changed", {
        width: 640,
        height: 240,
      }),
    );
    host.receive(
      notification("ui/notifications/host-context-changed", {
        theme: "dark",
        locale: "ar",
        displayMode: "fullscreen",
      }),
    );
    await Bun.sleep(0);
    expect(host.bridge.getSnapshot().context).toMatchObject({
      theme: "dark",
      locale: "ar",
      displayMode: "fullscreen",
    });
    expect(documentElement.lang).toBe("ar");
    expect(documentElement.dir).toBe("rtl");
    expect(publications).toBeGreaterThan(1);
    unsubscribe();
  });

  test("correlates concurrent tool responses and ignores unknown and duplicate ids", async () => {
    const host = setup();
    await host.connect();
    const first = host.bridge.requestTool({
      name: "lookup_case_law",
      arguments: { query: "first" },
    });
    const second = host.bridge.requestTool({
      name: "search_case_law",
      arguments: { query: "second" },
    });
    const calls = host.target.messages.filter(
      (message) => "method" in message && message.method === "tools/call",
    );
    const firstCall = calls.at(0);
    const secondCall = calls.at(1);
    if (
      firstCall === undefined ||
      secondCall === undefined ||
      !("id" in firstCall) ||
      !("id" in secondCall)
    ) {
      throw new TypeError("Expected two tool requests");
    }
    host.receive(
      response(999_999, { content: [], structuredContent: { wrong: true } }),
    );
    host.receive(
      response(secondCall.id, { content: [], structuredContent: { order: 2 } }),
    );
    host.receive(
      response(firstCall.id, { content: [], structuredContent: { order: 1 } }),
    );
    expect(await first).toMatchObject({ structuredContent: { order: 1 } });
    expect(await second).toMatchObject({ structuredContent: { order: 2 } });
    host.receive(
      response(firstCall.id, {
        content: [],
        structuredContent: { duplicate: true },
      }),
    );
    await Bun.sleep(0);
    expect(host.bridge.getSnapshot().result.status).toBe("error");
  });

  test("refuses malformed and wrong-shape messages without throwing", async () => {
    const host = setup();
    await host.connect();
    expect(() => host.receive({ unrelated: true })).not.toThrow();
    expect(() => host.receive({ jsonrpc: "2.0", method: 42 })).not.toThrow();
    await Bun.sleep(0);
    expect(host.bridge.getSnapshot().result.status).toBe("error");
  });

  test("ignores notifications from a different source without raising an error", async () => {
    const host = setup();
    await host.connect();
    const before = structuredClone(host.bridge.getSnapshot());
    const stranger = new MessageChannel().port1;
    host.receive(
      notification("ui/notifications/tool-input", {
        arguments: { wrong: true },
      }),
      stranger,
    );
    await Bun.sleep(0);
    expect(host.bridge.getSnapshot()).toEqual(before);
    expect(host.bridge.getSnapshot().result.status).toBe("idle");
  });

  test("keeps a cancellation when its pending response arrives late", async () => {
    const host = setup();
    await host.connect();
    const calling = host.bridge.call({
      name: "search_case_law",
      arguments: { query: "delayed" },
    });
    const call = host.nextRequest("tools/call");
    host.receive(
      notification("ui/notifications/tool-cancelled", { reason: "cancelled" }),
    );
    await Bun.sleep(0);
    host.receive(
      response(call.id, { content: [], structuredContent: { late: true } }),
    );
    await calling;
    expect(host.bridge.getSnapshot().result).toEqual({
      status: "error",
      message: "cancelled",
    });
  });

  test("handles tool input, results, retries, errors, and unsupported tools", async () => {
    const host = setup();
    await host.connect();
    host.receive(
      notification("ui/notifications/tool-input", {
        arguments: { query: "one" },
      }),
    );
    await Bun.sleep(0);
    expect(host.bridge.getSnapshot().result.status).toBe("loading");
    host.receive(
      notification("ui/notifications/tool-result", {
        content: [],
        structuredContent: { rows: [1] },
      }),
    );
    await Bun.sleep(0);
    expect(host.bridge.getSnapshot().result).toEqual({
      status: "ready",
      view: { rows: [1] },
    });

    const retrying = host.bridge.retry();
    const retry = host.target.messages.find(
      (message) => "method" in message && message.method === "tools/call",
    );
    if (retry === undefined || !("id" in retry)) {
      throw new TypeError("Expected retry");
    }
    host.receive(
      response(retry.id, {
        isError: true,
        content: [{ type: "text", text: "failed" }],
      }),
    );
    await retrying;
    expect(host.bridge.getSnapshot().result).toEqual({
      status: "error",
      message: "failed",
    });
  });

  test("uses host operations when supported and surfaces their failures", async () => {
    const host = setup();
    await host.connect();
    expect(host.bridge.supportsTools()).toBeTrue();

    const fullscreen = host.bridge.requestFullscreen();
    const fullscreenRequest = host.nextRequest("ui/request-display-mode");
    host.receive(response(fullscreenRequest.id, { mode: "fullscreen" }));
    await fullscreen;
    expect(host.bridge.getSnapshot().context.displayMode).toBe("fullscreen");

    const inline = host.bridge.requestInline();
    const inlineRequest = host.target.messages.find(
      (message) =>
        "method" in message &&
        message.method === "ui/request-display-mode" &&
        "params" in message &&
        message.params.mode === "inline",
    );
    if (inlineRequest === undefined || !("id" in inlineRequest)) {
      throw new TypeError("Expected inline request");
    }
    host.receive(response(inlineRequest.id, { mode: "inline" }));
    await inline;

    const opening = host.bridge.openLink("https://stella.example/decisions/1");
    const open = host.nextRequest("ui/open-link");
    host.receive(response(open.id, { isError: true }));
    await opening;
    expect(host.bridge.getSnapshot().result.status).toBe("error");
  });

  test("reports absent host capabilities and rejects unsafe links locally", async () => {
    const host = setup();
    await host.connect({});
    expect(host.bridge.supportsTools()).toBeFalse();
    const sent = host.target.messages.length;
    let failure: string | null | undefined;
    const unsafeUrl = ["java", "script:alert(1)"].join("");
    await host.bridge.openLink(unsafeUrl, (message) => {
      failure = message;
    });
    expect(failure).toBeNull();
    expect(host.target.messages).toHaveLength(sent);
  });

  test("detached failures and teardown notify subscribers without leaking listeners", async () => {
    const host = setup();
    await host.connect();
    let publications = 0;
    host.bridge.subscribe(() => {
      publications += 1;
    });
    host.bridge.detached(Promise.reject(new Error("detached")), "bridge test");
    await Bun.sleep(0);
    expect(host.bridge.getSnapshot().result.status).toBe("error");
    host.receive({
      jsonrpc: "2.0",
      id: 42,
      method: "ui/resource-teardown",
      params: {},
    });
    await Bun.sleep(0);
    expect(host.target.messages).toContainEqual(response(42, {}));
    const countAfterTeardown = publications;
    host.receive(
      notification("ui/notifications/tool-input", {
        arguments: { late: true },
      }),
    );
    expect(publications).toBe(countAfterTeardown);
  });
});
