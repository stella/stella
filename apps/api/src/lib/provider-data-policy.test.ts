import { EventType } from "@tanstack/ai";
import type { AdapterYieldChunk } from "@tanstack/ai";
import {
  isAbortShapedError,
  resolveDebugOption,
} from "@tanstack/ai/adapter-internals";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { AI_PROVIDERS, TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";

import { env } from "@/api/env";
import { DECISION_MODEL_PROVIDERS } from "@/api/lib/ai-config";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readProviderStatus } from "@/api/lib/observability/failure-evidence";
import {
  MANAGED_PROVIDER_UNAVAILABLE_CODE,
  PROVIDER_DATA_POLICY,
} from "@/api/lib/provider-data-policy";
import { createTanStackTextAdapterFactory } from "@/api/lib/tanstack-ai-models";

describe("provider request policy", () => {
  test("every provider declares its request policy", () => {
    expect(Object.keys(PROVIDER_DATA_POLICY.instance).toSorted()).toEqual(
      [
        ...AI_PROVIDERS,
        ...DECISION_MODEL_PROVIDERS,
        "agent_sandbox",
      ].toSorted(),
    );
  });

  test("accepts customer credentials for each supported provider", () => {
    const previousMock = env.USE_MOCK_AI;
    env.USE_MOCK_AI = false;
    try {
      for (const provider of TANSTACK_AI_PROVIDERS) {
        expect(
          typeof createTanStackTextAdapterFactory({
            provider,
            apiKey: "test-customer-key",
          }),
        ).toBe("function");
      }
    } finally {
      env.USE_MOCK_AI = previousMock;
    }
  });

  test("refuses managed providers without a configured request policy", () => {
    const previousMock = env.USE_MOCK_AI;
    env.USE_MOCK_AI = false;
    try {
      for (const provider of AI_PROVIDERS) {
        if (PROVIDER_DATA_POLICY.instance[provider].status === "supported") {
          continue;
        }
        expect(() => createTanStackTextAdapterFactory({ provider })).toThrow(
          HandlerError,
        );
        expect(() => createTanStackTextAdapterFactory({ provider })).toThrow(
          "Managed AI is not available",
        );
      }
    } finally {
      env.USE_MOCK_AI = previousMock;
    }
  });

  for (const keySource of ["byok", "instance"] as const) {
    for (const path of ["chat", "structured", "structured-stream"] as const) {
      for (const status of [400, 401, 403, 404, 429, "aborted"] as const) {
        test(`applies ${keySource} request options on ${path} with status ${status}`, async () => {
          const originalFetch = globalThis.fetch;
          const previousMock = env.USE_MOCK_AI;
          const previousKey = env.OPENROUTER_API_KEY;
          const requests: { url: string; body: unknown }[] = [];
          env.USE_MOCK_AI = false;
          env.OPENROUTER_API_KEY = "test-instance-key";
          globalThis.fetch = Object.assign(
            async (
              input: Parameters<typeof globalThis.fetch>[0],
              init?: RequestInit,
            ) => {
              const request =
                input instanceof Request
                  ? input
                  : new Request(input.toString(), init);
              requests.push({ url: request.url, body: await request.json() });
              if (status === "aborted") {
                throw new DOMException("Request aborted", "AbortError");
              }
              return new Response(
                JSON.stringify({
                  error: { code: status, message: "Request unavailable" },
                }),
                { status, headers: { "content-type": "application/json" } },
              );
            },
            { preconnect: originalFetch.preconnect },
          );
          try {
            const model = "google/gemini-2.5-flash";
            const adapter = createTanStackTextAdapterFactory({
              provider: "openrouter",
              ...(keySource === "byok" ? { apiKey: "test-customer-key" } : {}),
            })(model);
            const chatOptions = {
              model,
              logger: resolveDebugOption(false),
              messages: [{ role: "user" as const, content: "Reply with OK." }],
              modelOptions: {
                provider: { dataCollection: "allow" as const, zdr: false },
              },
            };
            const structuredOptions = {
              chatOptions,
              outputSchema: {
                type: "object",
                properties: { answer: { type: "string" } },
                required: ["answer"],
              },
            };
            const chunks: AdapterYieldChunk[] = [];
            const managedRefusal =
              keySource === "instance" && (status === 403 || status === 404);
            switch (path) {
              case "chat":
                for await (const chunk of adapter.chatStream(chatOptions)) {
                  chunks.push(chunk);
                }
                break;
              case "structured": {
                const result = await Result.tryPromise({
                  try: () => adapter.structuredOutput(structuredOptions),
                  catch: (error) => error,
                });
                expect(Result.isError(result)).toBe(true);
                if (Result.isOk(result)) {
                  throw new HandlerError({
                    status: 500,
                    message: "Expected request failure",
                  });
                }
                if (managedRefusal) {
                  expect(HandlerError.is(result.error)).toBe(true);
                  expect(result.error).toMatchObject({
                    status: 503,
                    code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
                  });
                } else if (status === "aborted") {
                  expect(isAbortShapedError(result.error)).toBe(true);
                } else {
                  expect(HandlerError.is(result.error)).toBe(false);
                  expect(readProviderStatus(result.error)?.status).toBe(status);
                }
                break;
              }
              case "structured-stream":
                if (!adapter.structuredOutputStream) {
                  throw new HandlerError({
                    status: 500,
                    message: "Structured stream unavailable",
                  });
                }
                for await (const chunk of adapter.structuredOutputStream(
                  structuredOptions,
                )) {
                  chunks.push(chunk);
                }
                break;
              default:
                path satisfies never;
            }
            if (path !== "structured") {
              const terminal = chunks.at(-1);
              expect(terminal?.type).toBe(EventType.RUN_ERROR);
              if (terminal?.type !== EventType.RUN_ERROR) {
                throw new HandlerError({
                  status: 500,
                  message: "Expected request failure",
                });
              }
              if (managedRefusal) {
                expect(terminal).toMatchObject({
                  code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
                  error: { code: MANAGED_PROVIDER_UNAVAILABLE_CODE },
                });
                expect(terminal.message).toContain(
                  "Managed AI is not available",
                );
                expect(terminal.rawEvent).toBeUndefined();
              } else if (status === "aborted") {
                expect(terminal.code).toBe("aborted");
              } else {
                expect(
                  readProviderStatus(terminal.rawEvent ?? terminal)?.status,
                ).toBe(status);
                expect(terminal.code).not.toBe(
                  MANAGED_PROVIDER_UNAVAILABLE_CODE,
                );
              }
            }
            expect(requests).toHaveLength(1);
            expect(requests.at(0)?.url).toBe(
              `https://${keySource === "byok" ? "openrouter.ai" : "eu.openrouter.ai"}/api/v1/chat/completions`,
            );
            expect(requests.at(0)?.body).toMatchObject({
              provider:
                keySource === "byok"
                  ? { data_collection: "allow", zdr: false }
                  : { data_collection: "deny", zdr: true },
            });
          } finally {
            globalThis.fetch = originalFetch;
            env.USE_MOCK_AI = previousMock;
            env.OPENROUTER_API_KEY = previousKey;
          }
        });
      }
    }
  }
});
