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
    const render = { type: "render", title: "Timeline", html: "<p>Dates</p>" };
    handle({
      source: parentWindow,
      origin: "https://web.example.test",
      data: render,
    });
    expect(onRender).toHaveBeenCalledWith(render);
    handle({
      source: innerWindow,
      origin: "null",
      data: { type: "resize", height: 300 },
    });
    expect(onGuestMessage).toHaveBeenCalledWith(
      { type: "resize", height: 300 },
      "https://web.example.test",
    );
    handle({
      source: parentWindow,
      origin: "https://alternate.example.test",
      data: render,
    });
    expect(onRender).toHaveBeenCalledTimes(1);
  });

  test("requires matching windows, origins, bounded bytes and strict message shapes", () => {
    const { parentWindow, innerWindow, onRender, onGuestMessage, handle } =
      setup();
    const render = { type: "render", title: "Timeline", html: "<p>Dates</p>" };
    handle({
      source: innerWindow,
      origin: "null",
      data: { type: "resize", height: 300 },
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
      { source: {}, origin: "null", data: { type: "resize", height: 300 } },
      {
        source: innerWindow,
        origin: "https://api.example.test",
        data: { type: "resize", height: 300 },
      },
      {
        source: innerWindow,
        origin: "null",
        data: { type: "resize", height: 300, title: "Timeline" },
      },
    ]) {
      handle(event);
    }
    expect(onGuestMessage).not.toHaveBeenCalled();
  });
});
