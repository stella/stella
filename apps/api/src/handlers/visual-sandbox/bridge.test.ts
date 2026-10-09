import { describe, expect, mock, test } from "bun:test";

import { VISUAL_SANDBOX_LIMITS } from "@stll/api-contract/visual-sandbox";

import {
  createVisualMessageHandler,
  visualGuestPortFrom,
  type VisualGuestPort,
} from "./bridge";

const createFakePort = () => {
  const state: { receive?: (data: unknown) => void; closed: boolean } = {
    closed: false,
  };
  const port: VisualGuestPort = {
    listen: (receive) => {
      state.receive = receive;
    },
    close: () => {
      state.closed = true;
    },
  };
  return { port, state, send: (data: unknown) => state.receive?.(data) };
};

const timelineRender = {
  type: "render",
  data: {},
  title: "Timeline",
  html: "<p>Dates</p>",
};

const setup = () => {
  const parentWindow = {};
  const innerWindow = {};
  const origins = [
    "https://web.example.test",
    "https://alternate.example.test",
  ];
  const rendered: { renderId?: string } = {};
  const onRender = mock(({ renderId }: { renderId: string }) => {
    rendered.renderId = renderId;
  });
  const onTheme = mock(() => undefined);
  const onGuestMessage = mock(() => undefined);
  const activation = { active: false };
  const clock = { now: 0 };
  const handle = createVisualMessageHandler({
    parentWindow,
    innerWindow,
    origins,
    outerOrigin: "https://api.example.test",
    onRender,
    onTheme,
    onGuestMessage,
    hasUserActivation: () => activation.active,
    now: () => clock.now,
    createRenderId: () => Bun.randomUUIDv7(),
  });
  const connect = (data?: unknown) => {
    const fake = createFakePort();
    handle({
      source: innerWindow,
      origin: "null",
      data: data ?? { kind: "port", renderId: rendered.renderId },
      ports: [fake.port],
    });
    return fake;
  };
  const renderView = () =>
    handle({
      source: parentWindow,
      origin: "https://web.example.test",
      data: timelineRender,
    });
  return {
    parentWindow,
    innerWindow,
    connect,
    renderView,
    rendered,
    onRender,
    onTheme,
    onGuestMessage,
    handle,
    activation,
    clock,
  };
};

describe("visual frame bridge", () => {
  test("refuses invalid initial themes without pinning the host", () => {
    const { parentWindow, onRender, handle } = setup();
    const render = {
      type: "render",
      title: "Theme",
      html: "<p>Theme</p>",
      data: {},
    };
    for (const variables of [
      { "--foreground": "red; background:blue" },
      { "--unknown": "red" },
    ]) {
      handle({
        source: parentWindow,
        origin: "https://alternate.example.test",
        data: { ...render, theme: { appearance: "dark", variables } },
      });
    }
    expect(onRender).not.toHaveBeenCalled();
    handle({
      source: parentWindow,
      origin: "https://web.example.test",
      data: render,
    });
    expect(onRender).toHaveBeenCalledTimes(1);
    expect(onRender).toHaveBeenCalledWith({
      ...render,
      links: [],
      renderId: expect.any(String),
    });
  });

  test("forwards validated themes only from the pinned host after a valid render", () => {
    const {
      parentWindow,
      innerWindow,
      onRender,
      onTheme,
      onGuestMessage,
      handle,
    } = setup();
    const theme = {
      appearance: "dark",
      variables: { "--foreground": "white" },
    };
    const data = { kind: "theme", theme };
    handle({
      source: parentWindow,
      origin: "https://alternate.example.test",
      data,
    });
    expect(onTheme).not.toHaveBeenCalled();
    handle({
      source: parentWindow,
      origin: "https://web.example.test",
      data: {
        type: "render",
        title: "Theme",
        html: "<p>Theme</p>",
        data: {},
        theme,
      },
    });
    expect(onRender).toHaveBeenCalledWith({
      type: "render",
      title: "Theme",
      html: "<p>Theme</p>",
      data: {},
      links: [],
      theme,
      renderId: expect.any(String),
    });
    for (const event of [
      { source: innerWindow, origin: "null", data },
      { source: {}, origin: "https://web.example.test", data },
      { source: parentWindow, origin: "https://alternate.example.test", data },
      {
        source: parentWindow,
        origin: "https://web.example.test",
        data: {
          kind: "theme",
          theme: {
            appearance: "dark",
            variables: { "--foreground": "red; background:blue" },
          },
        },
      },
      {
        source: parentWindow,
        origin: "https://web.example.test",
        data: {
          kind: "theme",
          theme: { appearance: "dark", variables: { "--unknown": "red" } },
        },
      },
    ]) {
      handle(event);
    }
    expect(onTheme).not.toHaveBeenCalled();
    expect(onGuestMessage).not.toHaveBeenCalled();
    handle({ source: parentWindow, origin: "https://web.example.test", data });
    expect(onTheme).toHaveBeenCalledTimes(1);
    expect(onTheme).toHaveBeenCalledWith(theme);
  });

  test("pins the first valid parent origin and returns validated guest messages to it", () => {
    const { parentWindow, connect, onRender, onGuestMessage, handle } = setup();
    handle({
      source: parentWindow,
      origin: "https://web.example.test",
      data: timelineRender,
    });
    expect(onRender).toHaveBeenCalledWith({
      ...timelineRender,
      links: [],
      renderId: expect.any(String),
    });
    connect().send({ kind: "resize", height: 300 });
    expect(onGuestMessage).toHaveBeenCalledWith(
      { kind: "resize", height: 300 },
      "https://web.example.test",
    );
    handle({
      source: parentWindow,
      origin: "https://alternate.example.test",
      data: timelineRender,
    });
    expect(onRender).toHaveBeenCalledTimes(1);
  });

  test("normalizes render markup and refuses credential controls before pinning the host", () => {
    const { parentWindow, onRender, handle } = setup();
    handle({
      source: parentWindow,
      origin: "https://web.example.test",
      data: {
        type: "render",
        data: {},
        title: "Form",
        html: '<input type="password">',
      },
    });
    expect(onRender).not.toHaveBeenCalled();
    handle({
      source: parentWindow,
      origin: "https://alternate.example.test",
      data: {
        type: "render",
        data: {},
        title: "Timeline",
        html: '<p onclick="void 0">Dates</p>',
      },
    });
    expect(onRender).toHaveBeenCalledWith({
      type: "render",
      data: {},
      title: "Timeline",
      html: "<p>Dates</p>",
      links: [],
      renderId: expect.any(String),
    });
  });

  test("the frame shell forwards sizing without forwarding link actions", () => {
    const { renderView, connect, onGuestMessage, activation } = setup();
    renderView();
    const { send } = connect();
    activation.active = true;
    send({ kind: "open-link", url: "https://example.test/decision" });
    expect(onGuestMessage).not.toHaveBeenCalled();
    send({ kind: "resize", height: 300 });
    expect(onGuestMessage).toHaveBeenCalledTimes(1);
  });

  test("primitive events and unavailable origins do not pin a host", () => {
    for (const data of [null, undefined, 42, true, "render", []]) {
      const { parentWindow, onRender, handle } = setup();
      handle({
        source: parentWindow,
        origin: "https://web.example.test",
        data,
      });
      handle({
        source: parentWindow,
        origin: "null",
        data: {
          type: "render",
          title: "Timeline",
          html: "<p>Dates</p>",
          data: {},
        },
      });
      expect(onRender).not.toHaveBeenCalled();
      handle({
        source: parentWindow,
        origin: "https://alternate.example.test",
        data: {
          type: "render",
          title: "Timeline",
          html: "<p>Dates</p>",
          data: {},
        },
      });
      expect(onRender).toHaveBeenCalledTimes(1);
    }
  });

  test("requires matching windows, origins, bounded bytes and strict message shapes", () => {
    const {
      parentWindow,
      renderView,
      connect,
      rendered,
      onRender,
      onGuestMessage,
      handle,
    } = setup();
    for (const event of [
      { source: {}, origin: "https://web.example.test", data: timelineRender },
      {
        source: parentWindow,
        origin: "https://other.example.test",
        data: timelineRender,
      },
      {
        source: parentWindow,
        origin: "https://api.example.test",
        data: timelineRender,
      },
      {
        source: parentWindow,
        origin: "https://web.example.test",
        data: { ...timelineRender, extra: "Dates" },
      },
      {
        source: parentWindow,
        origin: "https://web.example.test",
        data: {
          ...timelineRender,
          html: "§".repeat(VISUAL_SANDBOX_LIMITS.htmlBytes),
        },
      },
    ]) {
      handle(event);
    }
    expect(onRender).not.toHaveBeenCalled();
    renderView();
    const { send } = connect();
    for (const data of [
      { kind: "resize", height: 0 },
      { kind: "resize", height: 300, title: "Timeline" },
      { kind: "port", renderId: rendered.renderId },
      "resize",
    ]) {
      send(data);
    }
    expect(onGuestMessage).not.toHaveBeenCalled();
    send({ kind: "resize", height: 300 });
    expect(onGuestMessage).toHaveBeenCalledTimes(1);
  });

  test("binds only the view's first port, from the view frame, after a render", () => {
    const {
      innerWindow,
      renderView,
      connect,
      rendered,
      onGuestMessage,
      handle,
    } = setup();
    const resize = { kind: "resize", height: 300 };
    const offer = (event: {
      source: unknown;
      origin: string;
      data?: unknown;
      count?: number;
    }) => {
      const fakes = Array.from({ length: event.count ?? 1 }, createFakePort);
      handle({
        source: event.source,
        origin: event.origin,
        data: event.data ?? { kind: "port", renderId: rendered.renderId },
        ports: fakes.map(({ port }) => port),
      });
      for (const fake of fakes) {
        fake.send(resize);
      }
    };
    // Before a render pins the host, no port is bound.
    connect().send(resize);
    expect(onGuestMessage).not.toHaveBeenCalled();
    renderView();
    for (const event of [
      { source: {}, origin: "null" },
      { source: innerWindow, origin: "https://web.example.test" },
      { source: innerWindow, origin: "null", data: { kind: "ports" } },
      {
        source: innerWindow,
        origin: "null",
        data: { kind: "port", renderId: rendered.renderId, id: 1 },
      },
      { source: innerWindow, origin: "null", data: { kind: "port" } },
      {
        source: innerWindow,
        origin: "null",
        data: { kind: "port", renderId: Bun.randomUUIDv7() },
      },
      { source: innerWindow, origin: "null", count: 0 },
      { source: innerWindow, origin: "null", count: 2 },
    ]) {
      offer(event);
    }
    expect(onGuestMessage).not.toHaveBeenCalled();
    const first = connect();
    const second = connect();
    expect(second.state.closed).toBe(true);
    second.send(resize);
    expect(onGuestMessage).not.toHaveBeenCalled();
    first.send(resize);
    expect(onGuestMessage).toHaveBeenCalledTimes(1);
  });

  test("ignores view messages sent to the window instead of the port", () => {
    const {
      innerWindow,
      renderView,
      connect,
      onGuestMessage,
      handle,
      activation,
    } = setup();
    renderView();
    connect();
    activation.active = true;
    for (const data of [
      { kind: "resize", height: 300 },
      { kind: "ready", size: { width: 300, height: 300 } },
      { kind: "open-link", url: "https://example.test/decision" },
    ]) {
      handle({ source: innerWindow, origin: "null", data });
    }
    expect(onGuestMessage).not.toHaveBeenCalled();
  });

  test("each render binds a fresh port and closes the previous one", () => {
    const { renderView, connect, onGuestMessage } = setup();
    renderView();
    const previous = connect();
    previous.send({ kind: "resize", height: 100 });
    expect(onGuestMessage).toHaveBeenCalledTimes(1);
    renderView();
    expect(previous.state.closed).toBe(true);
    previous.send({ kind: "resize", height: 200 });
    expect(onGuestMessage).toHaveBeenCalledTimes(1);
    const next = connect();
    expect(next.state.closed).toBe(false);
    next.send({ kind: "resize", height: 300 });
    expect(onGuestMessage).toHaveBeenCalledTimes(2);
    expect(onGuestMessage).toHaveBeenLastCalledWith(
      { kind: "resize", height: 300 },
      "https://web.example.test",
    );
  });

  test("binds the port of the latest render when an earlier view's port arrives late", () => {
    const { renderView, connect, rendered, onGuestMessage } = setup();
    renderView();
    const firstRenderId = rendered.renderId;
    renderView();
    const stale = connect({ kind: "port", renderId: firstRenderId });
    expect(stale.state.closed).toBe(true);
    stale.send({ kind: "resize", height: 100 });
    expect(onGuestMessage).not.toHaveBeenCalled();
    const current = connect();
    expect(current.state.closed).toBe(false);
    current.send({ kind: "resize", height: 300 });
    expect(onGuestMessage).toHaveBeenCalledTimes(1);
    expect(onGuestMessage).toHaveBeenLastCalledWith(
      { kind: "resize", height: 300 },
      "https://web.example.test",
    );
  });

  test("rejects and closes ports offered without the current render id", () => {
    const { renderView, connect, rendered, onGuestMessage } = setup();
    renderView();
    for (const data of [
      { kind: "port" },
      { kind: "port", renderId: Bun.randomUUIDv7() },
      { kind: "port", renderId: "render" },
    ]) {
      const offered = connect(data);
      expect(offered.state.closed).toBe(true);
      offered.send({ kind: "resize", height: 100 });
    }
    expect(onGuestMessage).not.toHaveBeenCalled();
    connect({ kind: "port", renderId: rendered.renderId }).send({
      kind: "resize",
      height: 300,
    });
    expect(onGuestMessage).toHaveBeenCalledTimes(1);
  });

  test("receives view messages on a browser message port", async () => {
    const { innerWindow, renderView, rendered, onGuestMessage, handle } =
      setup();
    renderView();
    const channel = new MessageChannel();
    handle({
      source: innerWindow,
      origin: "null",
      data: { kind: "port", renderId: rendered.renderId },
      ports: [visualGuestPortFrom(channel.port2)],
    });
    const delivered = new Promise<void>((resolve) => {
      onGuestMessage.mockImplementationOnce(() => {
        resolve();
        return undefined;
      });
    });
    channel.port1.postMessage({ kind: "resize", height: 300 });
    await delivered;
    expect(onGuestMessage).toHaveBeenCalledWith(
      { kind: "resize", height: 300 },
      "https://web.example.test",
    );
    channel.port1.close();
  });

  test("forwards port actions only right after a gesture inside the view, one of each kind per second", () => {
    const { parentWindow, connect, onGuestMessage, handle, activation, clock } =
      setup();
    handle({
      source: parentWindow,
      origin: "https://web.example.test",
      data: {
        type: "render",
        data: { courtYear: { buckets: [{ court: "CZ:ns", year: 2026 }] } },
        title: "Timeline",
        html: '<p>Dates</p><a href="https://example.test/decision">Source</a><script>const bucket = stella.data.courtYear.buckets[0]; [bucket.court, bucket.year];</script>',
        links: [{ id: "decision", decisionId: "decision-id" }],
      },
    });
    const actions = [
      { kind: "drill", court: "CZ:ns", year: 2026 },
      { kind: "open-internal", linkId: "decision" },
      { kind: "open-link", url: "https://example.test/decision" },
    ] as const;
    const { send } = connect();
    // Script on load, with no gesture: nothing reaches the app.
    for (const action of actions) {
      send(action);
    }
    expect(onGuestMessage).not.toHaveBeenCalled();
    // Sizing never needs a gesture.
    send({ kind: "resize", height: 300 });
    expect(onGuestMessage).toHaveBeenCalledTimes(1);
    activation.active = true;
    for (const [index, action] of actions.entries()) {
      clock.now = 1000 * (index + 1);
      send(action);
      expect(onGuestMessage).toHaveBeenLastCalledWith(
        action,
        "https://web.example.test",
      );
      // The same kind again within the second is dropped.
      clock.now += 999;
      send(action);
      expect(onGuestMessage).toHaveBeenCalledTimes(index + 2);
    }
    // Different kinds are independent: each is accepted again after a second.
    clock.now += 1;
    send(actions[0]);
    expect(onGuestMessage).toHaveBeenCalledTimes(actions.length + 2);
    activation.active = false;
    clock.now += 10_000;
    send(actions[1]);
    expect(onGuestMessage).toHaveBeenCalledTimes(actions.length + 2);
  });
});
