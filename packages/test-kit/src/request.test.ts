import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { runInRequest } from "./request";

test("an assertion inside a request rejects the outer promise with its original message", async () => {
  const error = await rejectionOf(
    runInRequest(() => {
      expect("request-scenario-actual").toBe("request-scenario-expected");
    }),
  );
  expect(error).toMatchObject({
    message: expect.stringContaining("request-scenario-expected"),
  });
});

test("an asynchronous assertion also rejects outside the HTTP error boundary", async () => {
  const error = await rejectionOf(
    runInRequest(async () => {
      await Promise.resolve();
      expect("async-scenario-actual").toBe("async-scenario-expected");
    }),
  );
  expect(error).toMatchObject({
    message: expect.stringContaining("async-scenario-expected"),
  });
});

test.each([undefined, null, "non-Error rejection"])(
  "preserves the original rejection value: %j",
  async (rejection) => {
    expect(
      await rejectionOf(
        runInRequest(() => {
          // oxlint-disable-next-line typescript/only-throw-error -- Non-Error values are the request-boundary rejection cases under test.
          throw rejection;
        }),
      ),
    ).toBe(rejection);
  },
);

test("successful scenarios run once and settle after their asynchronous work", async () => {
  const calls: string[] = [];
  await runInRequest(async () => {
    calls.push("started");
    await Promise.resolve();
    calls.push("finished");
  });
  expect(calls).toEqual(["started", "finished"]);
});
