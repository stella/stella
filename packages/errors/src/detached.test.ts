import { expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import { createDetached, DetachedFunctionOperandError } from "./detached";

const settle = async () => {
  await sleep(0);
};

test("hands a rejection to the sink with the call site's label", async () => {
  const received: { context: string; error: unknown }[] = [];
  const detached = createDetached((error, context) => {
    received.push({ context, error });
  });
  const error = new Error("boom");

  detached(Promise.reject(error), "feature.action");
  await settle();

  expect(received).toEqual([{ context: "feature.action", error }]);
});

test("leaves a fulfilled operation and a plain value alone", async () => {
  const received: unknown[] = [];
  const detached = createDetached((error) => {
    received.push(error);
  });

  detached(Promise.resolve("done"), "feature.resolved");
  detached(undefined, "feature.absent");
  await settle();

  expect(received).toEqual([]);
});

test("refuses a function operand instead of dropping work it never started", async () => {
  const received: { context: string; error: unknown }[] = [];
  const detached = createDetached((error, context) => {
    received.push({ context, error });
  });
  let started = false;
  const work = async () => {
    started = true;
  };

  // @ts-expect-error a function is work that was never started.
  detached(work, "feature.unstarted");
  await settle();

  expect(started).toBe(false);
  expect(received).toHaveLength(1);
  expect(received[0]?.context).toBe("feature.unstarted");
  expect(received[0]?.error).toBeInstanceOf(DetachedFunctionOperandError);
});
