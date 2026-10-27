import { afterEach, expect, jest, test } from "bun:test";

import { restoreRealTimers } from "./fake-timers";

afterEach(restoreRealTimers);

const realTurn = async (): Promise<void> => {
  // real-time: only real time can show a discarded fake timeout never fires.
  await Bun.sleep(20);
};

test("Bun discards a pending fake timeout when real timers return directly", async () => {
  jest.useFakeTimers();
  let fired = 0;
  setTimeout(() => {
    fired += 1;
  }, 1);
  jest.useRealTimers();
  await realTurn();

  expect(fired).toBe(0);
});

test("restoring fires each pending fake timeout once, then runs on real timers", async () => {
  jest.useFakeTimers();
  const fired: string[] = [];
  setTimeout(() => {
    fired.push("timeout");
    setTimeout(() => {
      fired.push("follow-up");
    }, 1);
  }, 60_000);

  restoreRealTimers();

  expect(jest.isFakeTimers()).toBe(false);
  expect(fired).toEqual(["timeout"]);
  await realTurn();
  expect(fired).toEqual(["timeout"]);
});

test("restoring returns while an interval is still scheduled", () => {
  jest.useFakeTimers();
  let ticks = 0;
  const interval = setInterval(() => {
    ticks += 1;
  }, 1000);
  setTimeout(() => undefined, 3000);

  restoreRealTimers();
  clearInterval(interval);

  expect(jest.isFakeTimers()).toBe(false);
  expect(ticks).toBe(3);
});

test("restoring on real timers leaves them untouched", async () => {
  let fired = 0;
  setTimeout(() => {
    fired += 1;
  }, 1);

  restoreRealTimers();

  expect(jest.isFakeTimers()).toBe(false);
  await realTurn();
  expect(fired).toBe(1);
});
