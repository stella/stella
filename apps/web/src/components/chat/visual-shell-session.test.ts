import { describe, expect, test } from "bun:test";
import type * as v from "valibot";

import type { visualRenderMessageSchema } from "@stll/api-contract/generated-visual";

import { createVisualShellSession } from "./visual-shell-session";

const nonceOne = "00000000-0000-4000-8000-000000000001";
const nonceTwo = "00000000-0000-4000-8000-000000000002";
const render = {
  type: "render",
  title: "Revenue",
  html: "<p>Revenue</p>",
  data: {},
  links: [],
} satisfies v.InferOutput<typeof visualRenderMessageSchema>;
const url = "https://api.example.test/visual-sandbox";

describe("visual shell document handshake", () => {
  test("releases a payload only once after the exact shell handshake", () => {
    const deliveries: unknown[] = [];
    const frameWindow = {
      postMessage: (message: unknown, targetOrigin: string) => {
        deliveries.push({ message, targetOrigin });
      },
    };
    const session = createVisualShellSession({ url, newNonce: () => nonceOne });
    const event = {
      source: frameWindow,
      origin: "null",
      data: { kind: "shell-ready", nonce: nonceOne },
    };
    expect(session.deliverRender({ event, frameWindow, message: render })).toBe(
      false,
    );
    expect(session.beginLoad()).toBe(`${url}#n=${nonceOne}`);
    for (const rejected of [
      { ...event, source: {} },
      { ...event, origin: "https://api.example.test" },
      { ...event, data: { kind: "shell-ready", nonce: nonceTwo } },
      { ...event, data: { ...event.data, extra: true } },
    ]) {
      expect(
        session.deliverRender({
          event: rejected,
          frameWindow,
          message: render,
        }),
      ).toBe(false);
      expect(session.isReady()).toBe(false);
    }
    expect(
      session.deliverRender({ event, frameWindow: null, message: render }),
    ).toBe(false);
    expect(session.deliverRender({ event, frameWindow, message: render })).toBe(
      true,
    );
    expect(session.isReady()).toBe(true);
    expect(deliveries).toEqual([{ message: render, targetOrigin: "*" }]);
    expect(session.deliverRender({ event, frameWindow, message: render })).toBe(
      false,
    );
    expect(deliveries).toHaveLength(1);
  });
  test("requires a fresh nonce after any document load", () => {
    const nonces = [nonceOne, nonceTwo];
    const deliveries: unknown[] = [];
    const frameWindow = {
      postMessage: (message: unknown, targetOrigin: string) => {
        deliveries.push({ message, targetOrigin });
      },
    };
    const session = createVisualShellSession({
      url,
      newNonce: () => nonces.shift() ?? nonceTwo,
    });
    session.beginLoad();
    const first = {
      source: frameWindow,
      origin: "null",
      data: { kind: "shell-ready", nonce: nonceOne },
    };
    expect(
      session.deliverRender({ event: first, frameWindow, message: render }),
    ).toBe(true);
    expect(session.beginLoad()).toBe(`${url}#n=${nonceTwo}`);
    expect(session.isReady()).toBe(false);
    expect(
      session.deliverRender({ event: first, frameWindow, message: render }),
    ).toBe(false);
    expect(session.isReady()).toBe(false);
    expect(deliveries).toHaveLength(1);
    expect(
      session.deliverRender({
        event: { ...first, data: { kind: "shell-ready", nonce: nonceTwo } },
        frameWindow,
        message: render,
      }),
    ).toBe(true);
    expect(deliveries).toHaveLength(2);
  });
});
