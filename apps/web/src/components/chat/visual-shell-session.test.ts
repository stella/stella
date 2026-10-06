import { describe, expect, test } from "bun:test";

import { createVisualShellSession } from "./visual-shell-session";

const nonceOne = "00000000-0000-4000-8000-000000000001";
const nonceTwo = "00000000-0000-4000-8000-000000000002";
const frameWindow = {};
const url = "https://api.example.test/visual-sandbox";

describe("visual shell document handshake", () => {
  test("releases a payload only once after the exact shell handshake", () => {
    const session = createVisualShellSession({ url, newNonce: () => nonceOne });
    const event = {
      source: frameWindow,
      origin: "null",
      data: { kind: "shell-ready", nonce: nonceOne },
    };
    expect(session.acceptReady({ event, frameWindow })).toBe(false);
    expect(session.beginLoad()).toBe(`${url}#n=${nonceOne}`);
    for (const rejected of [
      { ...event, source: {} },
      { ...event, origin: "https://api.example.test" },
      { ...event, data: { kind: "shell-ready", nonce: nonceTwo } },
      { ...event, data: { ...event.data, extra: true } },
    ]) {
      expect(session.acceptReady({ event: rejected, frameWindow })).toBe(false);
      expect(session.isReady()).toBe(false);
    }
    expect(session.acceptReady({ event, frameWindow: null })).toBe(false);
    expect(session.acceptReady({ event, frameWindow })).toBe(true);
    expect(session.isReady()).toBe(true);
    expect(session.acceptReady({ event, frameWindow })).toBe(false);
  });
  test("requires a fresh nonce after any document load", () => {
    const nonces = [nonceOne, nonceTwo];
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
    expect(session.acceptReady({ event: first, frameWindow })).toBe(true);
    expect(session.beginLoad()).toBe(`${url}#n=${nonceTwo}`);
    expect(session.isReady()).toBe(false);
    expect(session.acceptReady({ event: first, frameWindow })).toBe(false);
    expect(session.isReady()).toBe(false);
    expect(
      session.acceptReady({
        event: { ...first, data: { kind: "shell-ready", nonce: nonceTwo } },
        frameWindow,
      }),
    ).toBe(true);
  });
});
