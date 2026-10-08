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
  const onGuestMessage = mock(() => undefined);
  const handle = createVisualMessageHandler({
    parentWindow,
    innerWindow,
    origins,
    outerOrigin: "https://api.example.test",
    onRender,
    onGuestMessage,
  });
  return { parentWindow, innerWindow, onRender, onGuestMessage, handle };
};

describe("visual frame bridge", () => {
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
});
