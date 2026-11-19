import type { GetParameterCommandOutput } from "@aws-sdk/client-ssm";
import { afterEach, expect, jest, test } from "bun:test";

import { readParameter } from "./read-parameter";

afterEach(() => {
  jest.useRealTimers();
});

test.each(["enabled", "disabled"] as const)(
  "reads one parameter with decryption %s",
  async (decryption) => {
    jest.useFakeTimers();
    const result = await readParameter({
      name: "/test/grants",
      decryption,
      client: {
        send: async (command, { abortSignal }) => {
          expect(command.input).toEqual({
            Name: "/test/grants",
            WithDecryption: decryption === "enabled",
          });
          expect(abortSignal.aborted).toBe(false);
          return { Parameter: { Value: "", Version: 7 }, $metadata: {} };
        },
      },
    });
    expect(result.unwrap()).toEqual({ value: "", version: 7 });
    expect(jest.getTimerCount()).toBe(0);
  },
);

test.each([
  { name: "ParameterNotFound", reason: "not_found" },
  { name: "ParameterVersionNotFound", reason: "not_found" },
  { name: "AccessDenied", reason: "access_denied" },
  { name: "AccessDeniedException", reason: "access_denied" },
  { name: "TimeoutError", reason: "timeout" },
  { name: "AbortError", reason: "timeout" },
  { name: "InternalServerError", reason: "unavailable" },
])(
  "classifies $name without exposing provider messages",
  async ({ name, reason }) => {
    const result = await readParameter({
      name: "/test/grants",
      decryption: "enabled",
      client: {
        send: async () => {
          const error = new Error("private provider response");
          error.name = name;
          throw error;
        },
      },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.reason).toBe(reason);
      expect(JSON.stringify(result.error)).not.toContain(
        "private provider response",
      );
      expect(result.error._tag).toBe("ParameterStoreError");
    }
  },
);

test.each([undefined, {}, { Value: "grants" }, { Version: 1 }])(
  "rejects incomplete parameter responses: %j",
  async (Parameter) => {
    const result = await readParameter({
      name: "/test/grants",
      decryption: "enabled",
      client: { send: async () => ({ Parameter, $metadata: {} }) },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.reason).toBe("unavailable");
    }
  },
);

test("cancellation reaches an active parameter read", async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  const started = Promise.withResolvers<undefined>();
  const response = Promise.withResolvers<GetParameterCommandOutput>();
  const pending = readParameter({
    name: "/test/grants",
    decryption: "enabled",
    signal: controller.signal,
    client: {
      send: async (_command, { abortSignal }) => {
        started.resolve(undefined);
        abortSignal.addEventListener(
          "abort",
          () => response.reject(abortSignal.reason),
          { once: true },
        );
        return await response.promise;
      },
    },
  });
  await started.promise;
  expect(jest.getTimerCount()).toBe(1);
  controller.abort();
  const result = await pending;
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.reason).toBe("timeout");
  }
  expect(jest.getTimerCount()).toBe(0);
});

test("an unresponsive client times out even when it ignores cancellation", async () => {
  jest.useFakeTimers();
  const started = Promise.withResolvers<undefined>();
  let signal: AbortSignal | undefined;
  let settled = false;
  const response = Promise.withResolvers<GetParameterCommandOutput>();
  const pending = readParameter({
    name: "/test/grants",
    decryption: "enabled",
    client: {
      send: async (_command, options) => {
        signal = options.abortSignal;
        started.resolve(undefined);
        return await response.promise;
      },
    },
  }).then((result) => {
    settled = true;
    return result;
  });
  await started.promise;
  jest.advanceTimersByTime(4999);
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(signal?.aborted).toBe(false);
  expect(jest.getTimerCount()).toBe(1);
  jest.advanceTimersByTime(1);
  expect(signal?.aborted).toBe(true);
  const result = await pending;
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.reason).toBe("timeout");
  }
  expect(jest.getTimerCount()).toBe(0);
  response.resolve({ Parameter: { Value: "late", Version: 1 }, $metadata: {} });
  expect(await pending).toBe(result);
});
