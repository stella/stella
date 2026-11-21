import { expect, spyOn, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { sleep } from "./sleep";

test("cancellation preserves its reason and releases the timer and listener", async () => {
  const controller = new AbortController();
  const remove = spyOn(controller.signal, "removeEventListener");
  const clear = spyOn(globalThis, "clearTimeout");
  const reason = { type: "stopped" };
  try {
    const waiting = sleep(60_000, { signal: controller.signal });
    const observed = rejectionOf(waiting);
    controller.abort(reason);
    expect(await observed).toBe(reason);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
  } finally {
    remove.mockRestore();
    clear.mockRestore();
  }
});

test("an already aborted signal rejects without arming a timer", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Stopped", "AbortError");
  controller.abort(reason);
  const timer = spyOn(globalThis, "setTimeout");
  try {
    expect(
      await rejectionOf(sleep(60_000, { signal: controller.signal })),
    ).toBe(reason);
    expect(timer).not.toHaveBeenCalled();
  } finally {
    timer.mockRestore();
  }
});

test("normal completion removes the listener without aborting the caller", async () => {
  const controller = new AbortController();
  const remove = spyOn(controller.signal, "removeEventListener");
  try {
    await sleep(0, { signal: controller.signal });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(controller.signal.aborted).toBe(false);
  } finally {
    remove.mockRestore();
  }
});
