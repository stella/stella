import { describe, expect, test } from "bun:test";

import {
  VISUAL_GESTURE_WINDOW_MS,
  captureGestureEventReader,
  createVisualGestureGate,
  type GestureEventFields,
} from "./guest-gesture";

type TestEvent = {
  readonly isTrusted: boolean;
  readonly fields: GestureEventFields;
};

const setup = () => {
  const clock = { now: 0 };
  const gate = createVisualGestureGate({
    now: () => clock.now,
    readEvent: (event: TestEvent) => event.fields,
  });
  return { clock, gate };
};

const click = (isTrusted: boolean, detail = 1): TestEvent => ({
  isTrusted,
  fields: { type: "click", detail },
});

const keydown = (repeat: boolean): TestEvent => ({
  isTrusted: true,
  fields: { type: "keydown", repeat },
});

describe("view gesture tokens", () => {
  test("events the browser did not originate grant nothing", () => {
    const { gate } = setup();
    gate.observe(click(false));
    gate.observe(click(false));
    expect(gate.take()).toBe(false);
  });

  test("one trusted gesture backs exactly one action", () => {
    const { gate } = setup();
    expect(gate.take()).toBe(false);
    gate.observe(click(true));
    expect(gate.take()).toBe(true);
    expect(gate.take()).toBe(false);
    expect(gate.take()).toBe(false);
  });

  test("an unspent gesture lapses after the window", () => {
    const { clock, gate } = setup();
    gate.observe(click(true));
    clock.now = VISUAL_GESTURE_WINDOW_MS - 1;
    expect(gate.take()).toBe(true);
    gate.observe(click(true));
    clock.now += VISUAL_GESTURE_WINDOW_MS;
    expect(gate.take()).toBe(false);
  });

  test("a key press counts like a click, and each gesture backs its own action", () => {
    const { clock, gate } = setup();
    const listeners = new Map<string, (event: TestEvent) => void>();
    gate.listen({
      addEventListener: (type, listener, options) => {
        expect(options).toEqual({ capture: true });
        listeners.set(type, listener);
      },
    });
    expect([...listeners.keys()].toSorted()).toEqual(["click", "keydown"]);
    const dispatch = (event: TestEvent) =>
      listeners.get(event.fields.type)?.(event);
    dispatch({ isTrusted: false, fields: { type: "keydown", repeat: false } });
    expect(gate.take()).toBe(false);
    dispatch(keydown(false));
    expect(gate.take()).toBe(true);
    expect(gate.take()).toBe(false);
    clock.now = 10;
    dispatch(click(true));
    expect(gate.take()).toBe(true);
    clock.now = 20;
    dispatch(click(true));
    expect(gate.take()).toBe(true);
    expect(gate.take()).toBe(false);
  });

  test("a key press stays one gesture", () => {
    const { gate } = setup();
    gate.observe(keydown(false));
    expect(gate.take()).toBe(true);
    // The click a browser derives from Enter or Space on a control.
    gate.observe(click(true, 0));
    expect(gate.take()).toBe(false);
    gate.observe(keydown(true));
    gate.observe(keydown(true));
    expect(gate.take()).toBe(false);
  });

  test("a click with no key press before it is its own gesture", () => {
    const { gate } = setup();
    // Assistive technology activates a control with a click of detail 0.
    gate.observe(click(true, 0));
    expect(gate.take()).toBe(true);
    expect(gate.take()).toBe(false);
  });

  test("event fields come only from the reader", () => {
    const read = (fields: GestureEventFields) =>
      createVisualGestureGate({ now: () => 0, readEvent: () => fields });
    const held = { isTrusted: true, type: "keydown", repeat: true };
    const pressed = { isTrusted: true, type: "keydown", repeat: false };
    const readAsRepeat = read({ type: "keydown", repeat: true });
    readAsRepeat.observe(pressed);
    expect(readAsRepeat.take()).toBe(false);
    const readAsPress = read({ type: "keydown", repeat: false });
    readAsPress.observe(held);
    expect(readAsPress.take()).toBe(true);
  });
});

class TestDomEvent {
  readonly isTrusted = true;
  readonly #type: string;
  constructor(type: string) {
    this.#type = type;
  }
  get type() {
    return this.#type;
  }
}

class TestUiEvent extends TestDomEvent {
  readonly #detail: number;
  constructor(type: string, detail: number) {
    super(type);
    this.#detail = detail;
  }
  get detail() {
    return this.#detail;
  }
}

class TestKeyboardEvent extends TestUiEvent {
  readonly #repeat: boolean;
  constructor(repeat: boolean) {
    super("keydown", 0);
    this.#repeat = repeat;
  }
  get repeat() {
    return this.#repeat;
  }
}

describe("gesture event reader", () => {
  test("reads the fields through the event accessors", () => {
    const readEvent = captureGestureEventReader({
      event: TestDomEvent.prototype,
      uiEvent: TestUiEvent.prototype,
      keyboardEvent: TestKeyboardEvent.prototype,
    });
    expect(readEvent(new TestKeyboardEvent(true))).toEqual({
      type: "keydown",
      repeat: true,
    });
    expect(readEvent(new TestUiEvent("click", 2))).toEqual({
      type: "click",
      detail: 2,
    });
    expect(readEvent(new TestUiEvent("focus", 0))).toBeNull();
  });

  test("a gate without the accessors grants nothing", () => {
    const gate = createVisualGestureGate({
      now: () => 0,
      readEvent: captureGestureEventReader({
        event: {},
        uiEvent: TestUiEvent.prototype,
        keyboardEvent: TestKeyboardEvent.prototype,
      }),
    });
    gate.observe(new TestUiEvent("click", 1));
    gate.observe(new TestKeyboardEvent(false));
    expect(gate.take()).toBe(false);
  });
});
