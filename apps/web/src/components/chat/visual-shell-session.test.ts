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
    expect(session.beginLoad()).toBe(`${url}?load=1#n=${nonceOne}`);
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
  test("starts a fresh handshake only when a reloaded shell repeats the spent nonce", () => {
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
    const first = {
      source: frameWindow,
      origin: "null",
      data: { kind: "shell-ready", nonce: nonceOne },
    };
    expect(session.isReloadedShell({ event: first, frameWindow })).toBe(false);
    session.beginLoad();
    expect(session.isReloadedShell({ event: first, frameWindow })).toBe(false);
    expect(
      session.deliverRender({ event: first, frameWindow, message: render }),
    ).toBe(true);
    for (const other of [
      { ...first, source: {} },
      { ...first, origin: "https://api.example.test" },
      { ...first, data: { kind: "shell-ready", nonce: nonceTwo } },
    ]) {
      expect(session.isReloadedShell({ event: other, frameWindow })).toBe(
        false,
      );
    }
    expect(session.isReloadedShell({ event: first, frameWindow: null })).toBe(
      false,
    );
    expect(session.isReloadedShell({ event: first, frameWindow })).toBe(true);
    expect(session.beginLoad()).toBe(`${url}?load=2#n=${nonceTwo}`);
    expect(session.isReady()).toBe(false);
    expect(session.isReloadedShell({ event: first, frameWindow })).toBe(false);
    expect(
      session.deliverRender({ event: first, frameWindow, message: render }),
    ).toBe(false);
    expect(deliveries).toHaveLength(1);
    const second = { ...first, data: { kind: "shell-ready", nonce: nonceTwo } };
    expect(
      session.deliverRender({ event: second, frameWindow, message: render }),
    ).toBe(true);
    expect(deliveries).toHaveLength(2);
    expect(session.isReloadedShell({ event: first, frameWindow })).toBe(false);
  });
  test("never releases the payload twice for one nonce, whatever document repeats it", () => {
    const issued = [
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000012",
      "00000000-0000-4000-8000-000000000013",
    ];
    const pending = [...issued];
    const deliveries: string[] = [];
    // A navigated frame keeps its window proxy, so every document in it posts
    // from the same source.
    const frameWindow = {
      postMessage: () => {
        deliveries.push(currentNonce);
      },
    };
    let currentNonce = "";
    const session = createVisualShellSession({
      url,
      newNonce: () => {
        currentNonce = pending.shift() ?? "";
        return currentNonce;
      },
    });
    const ready = (nonce: string) => ({
      source: frameWindow,
      origin: "null",
      data: { kind: "shell-ready", nonce },
    });
    session.beginLoad();
    for (const [index, nonce] of issued.entries()) {
      expect(
        session.deliverRender({
          event: ready(nonce),
          frameWindow,
          message: render,
        }),
      ).toBe(true);
      // Every nonce issued so far is spent: none of them releases it again,
      // before or after the spent one restarts the handshake.
      for (const spent of issued.slice(0, index + 1)) {
        expect(
          session.deliverRender({
            event: ready(spent),
            frameWindow,
            message: render,
          }),
        ).toBe(false);
      }
      if (index < issued.length - 1) {
        expect(
          session.isReloadedShell({ event: ready(nonce), frameWindow }),
        ).toBe(true);
        session.beginLoad();
        for (const spent of issued.slice(0, index + 1)) {
          expect(
            session.deliverRender({
              event: ready(spent),
              frameWindow,
              message: render,
            }),
          ).toBe(false);
          expect(
            session.isReloadedShell({ event: ready(spent), frameWindow }),
          ).toBe(false);
        }
      }
    }
    expect(deliveries).toEqual(issued);
  });
});
