import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, jest, mock, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

import { scheduleIdle } from "./schedule-idle";

GlobalRegistrator.register();

const idleDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "requestIdleCallback",
);
const cancelDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "cancelIdleCallback",
);
afterEach(() => {
  if (idleDescriptor) {
    Object.defineProperty(window, "requestIdleCallback", idleDescriptor);
  } else {
    Reflect.deleteProperty(window, "requestIdleCallback");
  }
  if (cancelDescriptor) {
    Object.defineProperty(window, "cancelIdleCallback", cancelDescriptor);
  } else {
    Reflect.deleteProperty(window, "cancelIdleCallback");
  }
});
afterAll(unregisterDomEnvironment);

test("idle work uses the native timeout and cancels its native handle", () => {
  const callback = mock(() => {});
  const tasks = new Map<number, IdleRequestCallback>();
  const request = mock((task: IdleRequestCallback) => {
    tasks.set(7, task);
    return 7;
  });
  const cancel = mock((handle: number) => {
    tasks.delete(handle);
  });
  Object.defineProperty(window, "requestIdleCallback", {
    configurable: true,
    value: request,
  });
  Object.defineProperty(window, "cancelIdleCallback", {
    configurable: true,
    value: cancel,
  });
  const cancelWork = scheduleIdle(callback, { timeout: 250 });
  expect(request).toHaveBeenCalledWith(callback, { timeout: 250 });
  cancelWork();
  expect(cancel).toHaveBeenCalledWith(7);
  expect(tasks.size).toBe(0);
  expect(callback).not.toHaveBeenCalled();
});

test("native idle work runs its callback", () => {
  const callback = mock(() => {});
  const request = mock((task: IdleRequestCallback) => {
    task({ didTimeout: false, timeRemaining: () => 10 });
    return 1;
  });
  Object.defineProperty(window, "requestIdleCallback", {
    configurable: true,
    value: request,
  });
  scheduleIdle(callback);
  expect(callback).toHaveBeenCalledTimes(1);
});

for (const timeout of [undefined, 250]) {
  test(`without idle callbacks, the timer runs after ${timeout ?? 0} ms and can be cancelled`, () => {
    jest.useFakeTimers();
    const descriptor = Object.getOwnPropertyDescriptor(
      window,
      "requestIdleCallback",
    );
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      value: undefined,
    });
    try {
      const callback = mock(() => {});
      const cancelled = mock(() => {});
      scheduleIdle(callback, { timeout });
      scheduleIdle(cancelled, { timeout })();
      expect(callback).not.toHaveBeenCalled();
      if (timeout !== undefined) {
        jest.advanceTimersByTime(timeout - 1);
        expect(callback).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
      } else {
        jest.advanceTimersByTime(0);
      }
      expect(callback).toHaveBeenCalledTimes(1);
      expect(cancelled).not.toHaveBeenCalled();
    } finally {
      if (descriptor) {
        Object.defineProperty(window, "requestIdleCallback", descriptor);
      } else {
        Reflect.deleteProperty(window, "requestIdleCallback");
      }
    }
  });
}
