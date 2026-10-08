import { describe, expect, test } from "bun:test";

import {
  VISUAL_GESTURE_WINDOW_MS,
  createVisualGestureGate,
} from "./guest-gesture";

const setup = () => {
  const clock = { now: 0 };
  const gate = createVisualGestureGate({ now: () => clock.now });
  return { clock, gate };
};

describe("view gesture tokens", () => {
  test("events the browser did not originate grant nothing", () => {
    const { gate } = setup();
    gate.observe({ isTrusted: false, type: "click", detail: 1 });
    gate.observe({ isTrusted: false, type: "click", detail: 1 });
    expect(gate.take()).toBe(false);
  });

  test("one trusted gesture backs exactly one action", () => {
    const { gate } = setup();
    expect(gate.take()).toBe(false);
    gate.observe({ isTrusted: true, type: "click", detail: 1 });
    expect(gate.take()).toBe(true);
    expect(gate.take()).toBe(false);
    expect(gate.take()).toBe(false);
  });

  test("an unspent gesture lapses after the window", () => {
    const { clock, gate } = setup();
    gate.observe({ isTrusted: true, type: "click", detail: 1 });
    clock.now = VISUAL_GESTURE_WINDOW_MS - 1;
    expect(gate.take()).toBe(true);
    gate.observe({ isTrusted: true, type: "click", detail: 1 });
    clock.now += VISUAL_GESTURE_WINDOW_MS;
    expect(gate.take()).toBe(false);
  });

  test("a key press counts like a click, and each gesture backs its own action", () => {
    const { clock, gate } = setup();
    const listeners = new Map<
      string,
      (event: {
        readonly isTrusted: boolean;
        readonly type: string;
        readonly detail?: number;
      }) => void
    >();
    gate.listen({
      addEventListener: (type, listener, options) => {
        expect(options).toEqual({ capture: true });
        listeners.set(type, listener);
      },
    });
    expect([...listeners.keys()].toSorted()).toEqual(["click", "keydown"]);
    const press = (type: string, isTrusted: boolean) =>
      listeners.get(type)?.({ isTrusted, type, detail: 1 });
    press("keydown", false);
    expect(gate.take()).toBe(false);
    press("keydown", true);
    expect(gate.take()).toBe(true);
    expect(gate.take()).toBe(false);
    clock.now = 10;
    press("click", true);
    expect(gate.take()).toBe(true);
    clock.now = 20;
    press("click", true);
    expect(gate.take()).toBe(true);
    expect(gate.take()).toBe(false);
  });

  test("a key press stays one gesture", () => {
    const { gate } = setup();
    gate.observe({ isTrusted: true, type: "keydown", repeat: false });
    expect(gate.take()).toBe(true);
    // The click a browser derives from Enter or Space on a control.
    gate.observe({ isTrusted: true, type: "click", detail: 0 });
    expect(gate.take()).toBe(false);
    gate.observe({ isTrusted: true, type: "keydown", repeat: true });
    gate.observe({ isTrusted: true, type: "keydown", repeat: true });
    expect(gate.take()).toBe(false);
  });

  test("a click with no key press before it is its own gesture", () => {
    const { gate } = setup();
    // Assistive technology activates a control with a click of detail 0.
    gate.observe({ isTrusted: true, type: "click", detail: 0 });
    expect(gate.take()).toBe(true);
    expect(gate.take()).toBe(false);
  });
});
