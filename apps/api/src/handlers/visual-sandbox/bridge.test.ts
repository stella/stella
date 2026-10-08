import { describe, expect, mock, test } from "bun:test";

import { VISUAL_SANDBOX_LIMITS } from "@stll/api-contract/visual-sandbox";

import { createVisualMessageHandler } from "./bridge";

const setup = () => {
  const parentWindow = {};
  const innerWindow = {};
  const origins = [
    "https://web.example.test",
    "https://alternate.example.test",
  ];
  const onRender = mock(() => undefined);
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
  });
  return {
    parentWindow,
    innerWindow,
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
    expect(onRender.mock.calls).toEqual([[{ ...render, links: [] }]]);
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
    expect(onTheme.mock.calls).toEqual([[theme]]);
  });

  test("pins the first valid parent origin and returns validated guest messages to it", () => {
    const { parentWindow, innerWindow, onRender, onGuestMessage, handle } =
      setup();
    const render = {
      type: "render",
      data: {},
      title: "Timeline",
      html: "<p>Dates</p>",
    };
    handle({
      source: parentWindow,
      origin: "https://web.example.test",
      data: render,
    });
    expect(onRender).toHaveBeenCalledWith({ ...render, links: [] });
    handle({
      source: innerWindow,
      origin: "null",
      data: { kind: "resize", height: 300 },
    });
    expect(onGuestMessage).toHaveBeenCalledWith(
      { kind: "resize", height: 300 },
      "https://web.example.test",
    );
    handle({
      source: parentWindow,
      origin: "https://alternate.example.test",
      data: render,
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
    });
  });

  test("the frame shell forwards sizing without forwarding link actions", () => {
    const { parentWindow, innerWindow, onGuestMessage, handle } = setup();
    handle({
      source: parentWindow,
      origin: "https://web.example.test",
      data: {
        type: "render",
        data: {},
        title: "Timeline",
        html: "<p>Dates</p>",
      },
    });
    handle({
      source: innerWindow,
      origin: "null",
      data: { kind: "open-link", url: "https://example.test/decision" },
    });
    expect(onGuestMessage).not.toHaveBeenCalled();
    handle({
      source: innerWindow,
      origin: "null",
      data: { kind: "resize", height: 300 },
    });
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
    const { parentWindow, innerWindow, onRender, onGuestMessage, handle } =
      setup();
    const render = {
      type: "render",
      data: {},
      title: "Timeline",
      html: "<p>Dates</p>",
    };
    handle({
      source: innerWindow,
      origin: "null",
      data: { kind: "resize", height: 300 },
    });
    expect(onGuestMessage).not.toHaveBeenCalled();
    for (const event of [
      { source: {}, origin: "https://web.example.test", data: render },
      {
        source: parentWindow,
        origin: "https://other.example.test",
        data: render,
      },
      {
        source: parentWindow,
        origin: "https://api.example.test",
        data: render,
      },
      {
        source: parentWindow,
        origin: "https://web.example.test",
        data: { ...render, extra: "Dates" },
      },
      {
        source: parentWindow,
        origin: "https://web.example.test",
        data: { ...render, html: "§".repeat(VISUAL_SANDBOX_LIMITS.htmlBytes) },
      },
    ]) {
      handle(event);
    }
    expect(onRender).not.toHaveBeenCalled();
    handle({
      source: parentWindow,
      origin: "https://web.example.test",
      data: render,
    });
    for (const event of [
      { source: {}, origin: "null", data: { kind: "resize", height: 300 } },
      {
        source: innerWindow,
        origin: "https://api.example.test",
        data: { kind: "resize", height: 300 },
      },
      {
        source: innerWindow,
        origin: "null",
        data: { kind: "resize", height: 300, title: "Timeline" },
      },
    ]) {
      handle(event);
    }
    expect(onGuestMessage).not.toHaveBeenCalled();
  });

  test("forwards guest actions only right after a gesture inside the view, one of each kind per second", () => {
    const {
      parentWindow,
      innerWindow,
      onGuestMessage,
      handle,
      activation,
      clock,
    } = setup();
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
    const send = (data: unknown) =>
      handle({ source: innerWindow, origin: "null", data });
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
