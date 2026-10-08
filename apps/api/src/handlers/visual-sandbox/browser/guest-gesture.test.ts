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
    gate.observe({ isTrusted: false });
    gate.observe({ isTrusted: false });
    expect(gate.take()).toBe(false);
  });

  test("one trusted gesture backs exactly one action", () => {
    const { gate } = setup();
    expect(gate.take()).toBe(false);
    gate.observe({ isTrusted: true });
    expect(gate.take()).toBe(true);
    expect(gate.take()).toBe(false);
    expect(gate.take()).toBe(false);
  });

  test("an unspent gesture lapses after the window", () => {
    const { clock, gate } = setup();
    gate.observe({ isTrusted: true });
    clock.now = VISUAL_GESTURE_WINDOW_MS - 1;
    expect(gate.take()).toBe(true);
    gate.observe({ isTrusted: true });
    clock.now += VISUAL_GESTURE_WINDOW_MS;
    expect(gate.take()).toBe(false);
  });

  test("a key press counts like a click, and each gesture backs its own action", () => {
    const { clock, gate } = setup();
    const listeners = new Map<
      string,
      (event: { readonly isTrusted: boolean }) => void
    >();
    gate.listen({
      addEventListener: (type, listener, options) => {
        expect(options).toEqual({ capture: true });
        listeners.set(type, listener);
      },
    });
    expect([...listeners.keys()].toSorted()).toEqual(["click", "keydown"]);
    const press = (type: string, isTrusted: boolean) =>
      listeners.get(type)?.({ isTrusted });
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
});
