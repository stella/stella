import { expect, test } from "bun:test";

import { createDetached } from "./detached";

const settle = async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
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
