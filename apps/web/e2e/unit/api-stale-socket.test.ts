import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { withStaleSocketRetry } from "../helpers/api";

const failingThen = <T>(errors: readonly Error[], value: T) => {
  const calls = { count: 0 };
  const send = async (): Promise<T> => {
    const error = errors[calls.count];
    calls.count += 1;
    if (error !== undefined) {
      throw error;
    }
    return await Promise.resolve(value);
  };
  return { calls, send };
};

describe("idempotent API requests on a stale keep-alive socket", () => {
  test("a request the server dropped on a closed socket is sent once more", async () => {
    const { calls, send } = failingThen(
      [new Error("apiRequestContext.delete: socket hang up")],
      204,
    );

    expect(await withStaleSocketRetry(send)).toBe(204);
    expect(calls.count).toBe(2);
  });

  test("a reset reported as the cause of a wrapper error is recognised", async () => {
    const { calls, send } = failingThen(
      [new Error("request failed", { cause: new Error("read ECONNRESET") })],
      "ok",
    );

    expect(await withStaleSocketRetry(send)).toBe("ok");
    expect(calls.count).toBe(2);
  });

  test("a second reset is not retried again", async () => {
    const { calls, send } = failingThen(
      [new Error("socket hang up"), new Error("socket hang up")],
      204,
    );

    const rejection = await rejectionOf(withStaleSocketRetry(send));
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection instanceof Error && rejection.message).toBe(
      "socket hang up",
    );
    expect(calls.count).toBe(2);
  });

  test("any other failure surfaces unchanged without a retry", async () => {
    const timeout = new Error(
      "apiRequestContext.delete: Timeout 30000ms exceeded",
    );
    const { calls, send } = failingThen([timeout], 204);

    expect(await rejectionOf(withStaleSocketRetry(send))).toBe(timeout);
    expect(calls.count).toBe(1);
  });
});
