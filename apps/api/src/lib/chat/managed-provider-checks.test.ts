import { EventType } from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { Result, panic } from "better-result";
import { describe, expect, jest, spyOn, test } from "bun:test";

import { BYOK_DEFAULT_MODELS } from "@stll/ai-catalog";
import { sleep } from "@stll/concurrency/sleep";

import { env } from "@/api/env";
import { MANAGED_AI_RESIDENCIES } from "@/api/lib/chat/ai-data-policy";
import {
  checkManagedOpenRouterModel,
  startManagedProviderChecks,
} from "@/api/lib/chat/managed-provider-checks";
import { MANAGED_PROVIDER_UNAVAILABLE_CODE } from "@/api/lib/chat/provider-data-policy";
import type { startNonOverlappingInterval } from "@/api/lib/non-overlapping-interval";
import { createManagedOpenRouterText } from "@/api/lib/stella-openrouter-text-adapter";
import { createTanStackTextAdapterFactory } from "@/api/lib/tanstack-ai-models";
import {
  API_SHUTDOWN_OUTCOME,
  shutdownApiServices,
} from "@/api/server-shutdown";

const MODEL = BYOK_DEFAULT_MODELS.openrouter.chat.modelId;
const chatOptions = {
  model: MODEL,
  messages: [{ role: "user" as const, content: "fixture request" }],
  logger: resolveDebugOption(false),
};
const structuredOptions = {
  chatOptions,
  outputSchema: {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
  },
};

const saveSettings = () => ({
  FEATURE_MANAGED_PROVIDER_CHECKS: env.FEATURE_MANAGED_PROVIDER_CHECKS,
  MANAGED_PROVIDER_CHECK_INTERVAL_MS: env.MANAGED_PROVIDER_CHECK_INTERVAL_MS,
  MANAGED_PROVIDER_CHECK_TIMEOUT_MS: env.MANAGED_PROVIDER_CHECK_TIMEOUT_MS,
  OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
});

describe("managed request catalog checks", () => {
  test("disabled checks make no catalog requests", async () => {
    const previous = saveSettings();
    const originalFetch = globalThis.fetch;
    const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("Unexpected catalog request"),
    );
    try {
      env.FEATURE_MANAGED_PROVIDER_CHECKS = false;
      const close = await startManagedProviderChecks();
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const residency of MANAGED_AI_RESIDENCIES) {
        expect(checkManagedOpenRouterModel(MODEL, residency).isOk()).toBe(true);
      }
      await close();
    } finally {
      fetchSpy.mockRestore();
      globalThis.fetch = originalFetch;
      Object.assign(env, previous);
    }
  });

  test("refreshes availability through the bounded scheduler and drains on close", async () => {
    const previous = saveSettings();
    const originalFetch = globalThis.fetch;
    const scheduled: {
      options?: Parameters<typeof startNonOverlappingInterval>[0];
    } = {};
    let stopped = false;
    let missing = false;
    let requests = 0;
    let holding = false;
    let heldRequests = 0;
    const held = Promise.withResolvers<() => Response>();
    const heldStarted = Promise.withResolvers<undefined>();
    Object.assign(env, {
      FEATURE_MANAGED_PROVIDER_CHECKS: true,
      MANAGED_PROVIDER_CHECK_INTERVAL_MS: 53_000,
      MANAGED_PROVIDER_CHECK_TIMEOUT_MS: 17,
      OPENROUTER_API_KEY: "fixture-key",
    });
    globalThis.fetch = Object.assign(
      async () => {
        requests++;
        if (holding) {
          heldRequests++;
          if (heldRequests === 2) {
            heldStarted.resolve(undefined);
          }
          return (await held.promise)();
        }
        return Response.json({ data: missing ? [] : [{ id: MODEL }] });
      },
      { preconnect: originalFetch.preconnect },
    );
    let close: (() => Promise<void>) | undefined;
    try {
      close = await startManagedProviderChecks((options) => {
        scheduled.options = options;
        return async () => {
          stopped = true;
        };
      });
      expect(requests).toBe(2);
      expect(scheduled.options).toMatchObject({
        initialDelayMs: 53_000,
        intervalMs: 53_000,
      });
      const options = scheduled.options;
      if (options === undefined) {
        panic("Scheduler was not registered");
      }
      for (const residency of MANAGED_AI_RESIDENCIES) {
        expect(checkManagedOpenRouterModel(MODEL, residency).isOk()).toBe(true);
      }
      missing = true;
      await options.run();
      expect(requests).toBe(4);
      for (const residency of MANAGED_AI_RESIDENCIES) {
        expect(checkManagedOpenRouterModel(MODEL, residency).isErr()).toBe(
          true,
        );
      }
      missing = false;
      await options.run();
      expect(requests).toBe(6);
      for (const residency of MANAGED_AI_RESIDENCIES) {
        expect(checkManagedOpenRouterModel(MODEL, residency).isOk()).toBe(true);
      }
      holding = true;
      const refreshing = options.run();
      await heldStarted.promise;
      for (const residency of MANAGED_AI_RESIDENCIES) {
        expect(checkManagedOpenRouterModel(MODEL, residency).isOk()).toBe(true);
      }
      held.resolve(() => Response.json({ data: [] }));
      await refreshing;
      for (const residency of MANAGED_AI_RESIDENCIES) {
        expect(checkManagedOpenRouterModel(MODEL, residency).isErr()).toBe(
          true,
        );
      }
      await close();
      close = undefined;
      expect(stopped).toBe(true);
      for (const residency of MANAGED_AI_RESIDENCIES) {
        expect(checkManagedOpenRouterModel(MODEL, residency).isErr()).toBe(
          true,
        );
      }
    } finally {
      await close?.();
      globalThis.fetch = originalFetch;
      Object.assign(env, previous);
    }
  });

  test("startup checks both hosts and guards every request path before transport", async () => {
    const previous = saveSettings();
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    Object.assign(env, {
      FEATURE_MANAGED_PROVIDER_CHECKS: true,
      MANAGED_PROVIDER_CHECK_INTERVAL_MS: 53_000,
      MANAGED_PROVIDER_CHECK_TIMEOUT_MS: 37,
      OPENROUTER_API_KEY: "fixture-key",
    });
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request =
          input instanceof Request
            ? input
            : new Request(input.toString(), init);
        requests.push(request.url);
        if (new URL(request.url).pathname.endsWith("/models")) {
          return Response.json({
            data: new URL(request.url).hostname.startsWith("eu.")
              ? [{ id: MODEL }]
              : [],
          });
        }
        expect(await request.json()).toMatchObject({ model: MODEL });
        return Response.json(
          { error: { code: 400, message: "fixture stop" } },
          { status: 400 },
        );
      },
      { preconnect: originalFetch.preconnect },
    );
    let close: (() => Promise<void>) | undefined;
    try {
      for (const residency of MANAGED_AI_RESIDENCIES) {
        expect(checkManagedOpenRouterModel(MODEL, residency).isErr()).toBe(
          true,
        );
      }
      close = await startManagedProviderChecks();
      expect(requests).toHaveLength(2);
      for (const residency of MANAGED_AI_RESIDENCIES) {
        const adapter = createManagedOpenRouterText({
          model: MODEL,
          apiKey: "fixture-key",
          managedAIResidency: residency,
        }).unwrap();
        for (const model of [MODEL, `${MODEL}:online`, `${MODEL}:free`]) {
          const selectedChatOptions = { ...chatOptions, model };
          const selectedStructuredOptions = {
            ...structuredOptions,
            chatOptions: selectedChatOptions,
          };
          const refused = residency === "us" || model === `${MODEL}:online`;
          for (const path of [
            "chat",
            "structured",
            "structured-stream",
          ] as const) {
            const before = requests.length;
            if (path === "structured") {
              const result = await Result.tryPromise({
                try: async () =>
                  await adapter.structuredOutput(selectedStructuredOptions),
                catch: (error) => error,
              });
              expect(result.isErr()).toBe(true);
              if (refused && Result.isError(result)) {
                expect(result.error).toMatchObject({
                  status: 503,
                  code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
                });
              }
            } else {
              const chunks = [];
              for await (const chunk of path === "chat"
                ? adapter.chatStream(selectedChatOptions)
                : adapter.structuredOutputStream(selectedStructuredOptions)) {
                chunks.push(chunk);
              }
              expect(chunks.at(-1)?.type).toBe(EventType.RUN_ERROR);
              if (refused) {
                expect(chunks.at(-1)).toMatchObject({
                  code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
                });
              }
            }
            expect(requests.length - before).toBe(refused ? 0 : 1);
          }
        }
      }
      const beforeMissing = requests.length;
      const adapter = createManagedOpenRouterText({
        model: MODEL,
        apiKey: "fixture-key",
        managedAIResidency: "eu",
      }).unwrap();
      const missingChunks = [];
      for await (const chunk of adapter.chatStream({
        ...chatOptions,
        model: "fixture/unlisted",
      })) {
        missingChunks.push(chunk);
      }
      expect(missingChunks.at(-1)).toMatchObject({
        type: EventType.RUN_ERROR,
        code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
      });
      expect(requests).toHaveLength(beforeMissing);
      await close();
      close = undefined;
      for (const residency of MANAGED_AI_RESIDENCIES) {
        expect(checkManagedOpenRouterModel(MODEL, residency).isErr()).toBe(
          true,
        );
      }
    } finally {
      await close?.();
      globalThis.fetch = originalFetch;
      Object.assign(env, previous);
    }
  });
});

for (const residency of MANAGED_AI_RESIDENCIES) {
  for (const path of ["chat", "structured", "structured-stream"] as const) {
    for (const enabled of [false, true]) {
      for (const dataClass of ["customer", "public_corpus"] as const) {
        test(`managed ${residency} ${path} refuses debug logging of provider failures with checks ${enabled} and ${dataClass}`, async () => {
          const previous = saveSettings();
          const originalFetch = globalThis.fetch;
          const previousDebug = process.env["OPENROUTER_DEBUG"];
          const logSpy = spyOn(console, "log").mockImplementation(() => {});
          const groupSpy = spyOn(console, "group").mockImplementation(() => {});
          const groupEndSpy = spyOn(console, "groupEnd").mockImplementation(
            () => {},
          );
          const logged: unknown[] = [];
          const record = (message: string, meta?: Record<string, unknown>) => {
            logged.push({ message, meta });
          };
          const logger = resolveDebugOption({
            logger: {
              debug: record,
              info: record,
              warn: record,
              error: record,
            },
          });
          let requests = 0;
          Object.assign(env, {
            FEATURE_MANAGED_PROVIDER_CHECKS: enabled,
            MANAGED_PROVIDER_CHECK_INTERVAL_MS: 53_000,
            MANAGED_PROVIDER_CHECK_TIMEOUT_MS: 37,
            OPENROUTER_API_KEY: "fixture-key",
          });
          const requestBodies: unknown[] = [];
          let close: (() => Promise<void>) | undefined;
          process.env["OPENROUTER_DEBUG"] = "true";
          globalThis.fetch = Object.assign(
            async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
              const request =
                input instanceof Request
                  ? input
                  : new Request(input.toString(), init);
              if (new URL(request.url).pathname.endsWith("/models")) {
                return Response.json({ data: [{ id: MODEL }] });
              }
              expect(new URL(request.url).hostname).toBe(
                dataClass === "customer"
                  ? `${residency}.openrouter.ai`
                  : "eu.openrouter.ai",
              );
              requestBodies.push(await request.json());
              requests++;
              // The first response exercises the 5xx body; the next ends SDK retries.
              return Response.json(
                {
                  error: {
                    code: requests === 1 ? 503 : 400,
                    message: "fixture response content",
                  },
                },
                { status: requests === 1 ? 503 : 400 },
              );
            },
            { preconnect: originalFetch.preconnect },
          );
          try {
            close = await startManagedProviderChecks();
            const policy =
              dataClass === "customer"
                ? { dataClass, managedAIResidency: residency }
                : { dataClass };
            const adapter = createTanStackTextAdapterFactory({
              provider: "openrouter",
              ...policy,
            })(MODEL);
            const options = {
              ...chatOptions,
              logger,
              modelOptions: { models: ["fixture/fallback"] },
            };
            const structured = { ...structuredOptions, chatOptions: options };
            if (path === "structured") {
              const result = await Result.tryPromise({
                try: async () => await adapter.structuredOutput(structured),
                catch: (error) => error,
              });
              expect(result.isErr()).toBe(true);
            } else {
              const chunks = [];
              const stream =
                path === "chat"
                  ? adapter.chatStream(options)
                  : adapter.structuredOutputStream?.(structured);
              if (stream === undefined) {
                panic(
                  "Provider adapter did not expose structured output streaming.",
                );
              }
              for await (const chunk of stream) {
                chunks.push(chunk);
              }
              expect(chunks.at(-1)?.type).toBe(EventType.RUN_ERROR);
            }
            expect(requests).toBe(2);
            for (const body of requestBodies) {
              expect(body).not.toHaveProperty("models");
            }
            expect(logged).toEqual([]);
            expect(logSpy).not.toHaveBeenCalled();
          } finally {
            await close?.();
            logSpy.mockRestore();
            groupSpy.mockRestore();
            groupEndSpy.mockRestore();
            globalThis.fetch = originalFetch;
            if (previousDebug === undefined) {
              delete process.env["OPENROUTER_DEBUG"];
            } else {
              process.env["OPENROUTER_DEBUG"] = previousDebug;
            }
            Object.assign(env, previous);
          }
        });
      }
    }
  }
}

test("termination aborts stalled catalog requests within the service deadline", async () => {
  jest.useFakeTimers();
  const previous = saveSettings();
  const originalFetch = globalThis.fetch;
  const scheduled: {
    options?: Parameters<typeof startNonOverlappingInterval>[0];
  } = {};
  const started = Promise.withResolvers<undefined>();
  const stalled = Promise.withResolvers<Response>();
  const releaseClose = Promise.withResolvers<undefined>();
  const signals: AbortSignal[] = [];
  let requests = 0;
  let httpStopped = false;
  let close: (() => Promise<void>) | undefined;
  Object.assign(env, {
    FEATURE_MANAGED_PROVIDER_CHECKS: true,
    MANAGED_PROVIDER_CHECK_INTERVAL_MS: 53_000,
    MANAGED_PROVIDER_CHECK_TIMEOUT_MS: 30_000,
    OPENROUTER_API_KEY: "fixture-key",
  });
  globalThis.fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests++;
      if (requests <= 2) {
        return Response.json({ data: [{ id: MODEL }] });
      }
      const signal = init?.signal;
      if (signal === null || signal === undefined) {
        panic("Catalog request did not receive its cancellation signal");
      }
      signals.push(signal);
      if (signals.length === 2) {
        started.resolve(undefined);
      }
      return await stalled.promise;
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    close = await startManagedProviderChecks((options) => {
      scheduled.options = options;
      // Even a non-cooperative close must remain inside the server deadline.
      return async () => await releaseClose.promise;
    });
    const options = scheduled.options;
    if (options === undefined) {
      panic("Scheduler was not registered");
    }
    const refresh = options.run();
    await started.promise;
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    const deadlineMs = 31;
    const outcome = shutdownApiServices({
      closeManagedProviderChecks: close,
      closeBackgroundWorkers: async () => undefined,
      closeDatabaseLoginProbe: undefined,
      drainScheduler: undefined,
      onHttpStopError: () => undefined,
      relinquishChatTurnRuns: async () => "stored",
      stopHttp: async () => {
        httpStopped = true;
      },
      stopScheduler: () => undefined,
      stopSse: () => undefined,
      timeout: sleep(deadlineMs),
    });
    expect(httpStopped).toBe(true);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    jest.advanceTimersByTime(deadlineMs);
    expect(await outcome).toBe(API_SHUTDOWN_OUTCOME.timedOut);
    await refresh;
    for (const residency of MANAGED_AI_RESIDENCIES) {
      expect(checkManagedOpenRouterModel(MODEL, residency).isErr()).toBe(true);
    }
  } finally {
    releaseClose.resolve(undefined);
    await close?.();
    globalThis.fetch = originalFetch;
    Object.assign(env, previous);
    jest.useRealTimers();
  }
});
