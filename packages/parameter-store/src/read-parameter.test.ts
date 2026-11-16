import type { GetParameterCommandOutput } from "@aws-sdk/client-ssm";
import { expect, test } from "bun:test";

import { createFakeTimers } from "@stll/test-kit";

import { readParameter } from "./read-parameter";

test.each(["enabled", "disabled"] as const)(
  "reads one parameter with decryption %s",
  async (decryption) => {
    const timers = createFakeTimers();
    const result = await readParameter({
      name: "/test/grants",
      decryption,
      scheduleTimeout: (callback, delayMs) => {
        const timer = timers.setTimeout(callback, delayMs);
        return () => timers.clearTimeout(timer);
      },
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
    expect(timers.pendingTimers()).toBe(0);
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
  const timers = createFakeTimers();
  const controller = new AbortController();
  const started = Promise.withResolvers<undefined>();
  const response = Promise.withResolvers<GetParameterCommandOutput>();
  const pending = readParameter({
    name: "/test/grants",
    decryption: "enabled",
    signal: controller.signal,
    scheduleTimeout: (callback, delayMs) => {
      const timer = timers.setTimeout(callback, delayMs);
      return () => timers.clearTimeout(timer);
    },
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
  expect(timers.pendingTimers()).toBe(1);
  controller.abort();
  const result = await pending;
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.reason).toBe("timeout");
  }
  expect(timers.pendingTimers()).toBe(0);
});

test("an unresponsive client times out even when it ignores cancellation", async () => {
  const timers = createFakeTimers();
  const started = Promise.withResolvers<undefined>();
  let signal: AbortSignal | undefined;
  let settled = false;
  const response = Promise.withResolvers<GetParameterCommandOutput>();
  const pending = readParameter({
    name: "/test/grants",
    decryption: "enabled",
    scheduleTimeout: (callback, delayMs) => {
      const timer = timers.setTimeout(callback, delayMs);
      return () => timers.clearTimeout(timer);
    },
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
  await timers.advance(4999);
  expect(settled).toBe(false);
  expect(signal?.aborted).toBe(false);
  expect(timers.pendingTimers()).toBe(1);
  await timers.advance(1);
  expect(signal?.aborted).toBe(true);
  const result = await pending;
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.reason).toBe("timeout");
  }
  expect(timers.pendingTimers()).toBe(0);
  response.resolve({ Parameter: { Value: "late", Version: 1 }, $metadata: {} });
  expect(await pending).toBe(result);
});
