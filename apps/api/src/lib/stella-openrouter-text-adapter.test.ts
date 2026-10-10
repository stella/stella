import { chat, EventType } from "@tanstack/ai";
import type { AdapterYieldChunk, ContentPart } from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { Result, panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { BYOK_DEFAULT_MODELS } from "@stll/ai-catalog";

import { env } from "@/api/env";
import {
  fetchManagedOpenRouterCompletion,
  MANAGED_PROVIDER_UNAVAILABLE_CODE,
  PROVIDER_DATA_POLICY,
} from "@/api/lib/chat/provider-data-policy";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createManagedOpenRouterText,
  createStellaOpenRouterText,
  StellaOpenRouterTextAdapter,
} from "@/api/lib/stella-openrouter-text-adapter";

class InspectableOpenRouterAdapter extends StellaOpenRouterTextAdapter {
  convertForRequest(part: ContentPart) {
    return this.convertContentPart(part);
  }

  requestFor(
    options: Parameters<StellaOpenRouterTextAdapter["chatStream"]>[0],
  ) {
    return this.mapOptionsToRequest(options);
  }
}

describe("instance provider redirect policy", () => {
  test("preserves the caller cancellation error at the transport boundary", async () => {
    const originalFetch = globalThis.fetch;
    const cancellation = new DOMException("Fixture cancellation", "AbortError");
    const controller = new AbortController();
    controller.abort(cancellation);
    globalThis.fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        init?.signal?.throwIfAborted();
        return new Response(null);
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      const result = await fetchManagedOpenRouterCompletion(
        new Request("https://eu.openrouter.ai/api/v1/chat/completions", {
          signal: controller.signal,
        }),
      );
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error).toBe(cancellation);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  const model = BYOK_DEFAULT_MODELS.openrouter.chat.modelId;
  for (const scope of ["eu", "us", "public_corpus", "byok"] as const) {
    for (const path of ["chat", "structured", "structured-stream"] as const) {
      for (const status of [301, 302, 303, 307, 308, "opaque"] as const) {
        test(`${scope} preserves redirect policy on ${path} for ${status}`, async () => {
          const originalFetch = globalThis.fetch;
          const previousChecks = env.FEATURE_MANAGED_PROVIDER_CHECKS;
          env.FEATURE_MANAGED_PROVIDER_CHECKS = false;
          const requests: Request[] = [];
          const redirectedHost = "redirected-provider.invalid";
          globalThis.fetch = Object.assign(
            async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
              const request =
                input instanceof Request
                  ? input
                  : new Request(input.toString(), init);
              requests.push(request);
              expect(await request.clone().text()).toContain("fixture request");
              const redirect = new Response(null, {
                status: status === "opaque" ? 307 : status,
                headers: {
                  location: `https://${redirectedHost}/chat/completions`,
                },
              });
              if (status === "opaque") {
                Object.defineProperties(redirect, {
                  type: { value: "opaqueredirect" },
                  status: { value: 0 },
                });
              }
              // Model native fetch's redirect modes at the transport boundary.
              switch (request.redirect) {
                case "error":
                  throw new TypeError("Redirect refused");
                case "manual":
                  return redirect;
                case "follow":
                  requests.push(
                    new Request(
                      redirect.headers.get("location") ??
                        panic("Missing location"),
                      request,
                    ),
                  );
                  return Response.json(
                    { error: { code: 400, message: "Fixture failure" } },
                    { status: 400 },
                  );
                default:
                  request.redirect satisfies never;
                  return panic("Unknown redirect mode");
              }
            },
            { preconnect: originalFetch.preconnect },
          );
          try {
            let instance;
            switch (scope) {
              case "byok":
                instance = createStellaOpenRouterText(model, "fixture-key");
                break;
              case "public_corpus":
              case "eu":
              case "us":
                instance = createManagedOpenRouterText({
                  model,
                  apiKey: "fixture-key",
                  managedAIResidency:
                    scope === "public_corpus"
                      ? PROVIDER_DATA_POLICY.public_corpus.managedAIResidency
                      : scope,
                }).unwrap();
                break;
              default:
                scope satisfies never;
                panic("Unknown request scope");
            }
            const chatOptions = {
              model,
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
            if (path === "structured") {
              const result = await Result.tryPromise({
                try: async () =>
                  await instance.structuredOutput(structuredOptions),
                catch: (error) => error,
              });
              if (Result.isOk(result)) {
                panic("Expected request failure");
              }
              if (scope === "byok") {
                expect(HandlerError.is(result.error)).toBe(false);
              } else {
                expect(HandlerError.is(result.error)).toBe(true);
                expect(result.error).toMatchObject({
                  status: 503,
                  code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
                });
              }
            } else {
              const stream =
                path === "chat"
                  ? instance.chatStream(chatOptions)
                  : instance.structuredOutputStream(structuredOptions);
              let terminal: AdapterYieldChunk | undefined;
              for await (const chunk of stream) {
                terminal = chunk;
              }
              expect(terminal?.type).toBe(EventType.RUN_ERROR);
              if (terminal?.type !== EventType.RUN_ERROR) {
                panic("Expected terminal error");
              }
              if (scope === "byok") {
                expect(terminal.code).not.toBe(
                  MANAGED_PROVIDER_UNAVAILABLE_CODE,
                );
              } else {
                expect(terminal.code).toBe(MANAGED_PROVIDER_UNAVAILABLE_CODE);
                expect(terminal.rawEvent).toBeUndefined();
              }
            }
            const expectedHost =
              scope === "byok"
                ? "openrouter.ai"
                : `${scope === "public_corpus" ? PROVIDER_DATA_POLICY.public_corpus.managedAIResidency : scope}.openrouter.ai`;
            expect(requests.map(({ url }) => new URL(url).hostname)).toEqual(
              scope === "byok"
                ? [expectedHost, redirectedHost]
                : [expectedHost],
            );
          } finally {
            globalThis.fetch = originalFetch;
            env.FEATURE_MANAGED_PROVIDER_CHECKS = previousChecks;
          }
        });
      }
    }
  }
});

const adapter = new InspectableOpenRouterAdapter(
  { apiKey: "test-openrouter-key" },
  "google/gemini-2.5-flash",
);

describe("OpenRouter document transport", () => {
  test("serializes inline PDF bytes as file_data instead of a URL or text", () => {
    const base64 = Buffer.from("%PDF-1.4\nsynthetic").toString("base64");

    expect(
      adapter.convertForRequest({
        type: "document",
        source: {
          type: "data",
          value: base64,
          mimeType: "application/pdf",
        },
        metadata: { filename: "contract.pdf" },
      }),
    ).toEqual({
      type: "file",
      file: {
        fileData: `data:application/pdf;base64,${base64}`,
        filename: "contract.pdf",
      },
    });
  });

  test("serializes a remote PDF as a file reference, never document prompt text", () => {
    expect(
      adapter.convertForRequest({
        type: "document",
        source: {
          type: "url",
          value: "https://example.com/contract.pdf",
          mimeType: "application/pdf",
        },
      }),
    ).toEqual({
      type: "file",
      file: { fileData: "https://example.com/contract.pdf" },
    });
  });

  test("emits the official snake_case file_data shape on the HTTP wire", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: unknown;
    const fetchStub = async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: RequestInit,
    ): Promise<Response> => {
      const request =
        input instanceof Request ? input : new Request(input.toString(), init);
      requestBody = await request.clone().json();
      return new Response(
        JSON.stringify({
          error: { code: "invalid_request", message: "synthetic stop" },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );
    };
    globalThis.fetch = Object.assign(fetchStub, {
      preconnect: originalFetch.preconnect,
    });

    try {
      const base64 = Buffer.from("%PDF-1.4\nwire").toString("base64");
      const wireAdapter = new StellaOpenRouterTextAdapter(
        { apiKey: "test-openrouter-key" },
        "google/gemini-2.5-flash",
      );
      for await (const _chunk of chat({
        adapter: wireAdapter,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", content: "Read the attached PDF." },
              {
                type: "document",
                source: {
                  type: "data",
                  value: base64,
                  mimeType: "application/pdf",
                },
                metadata: { filename: "contract.pdf" },
              },
            ],
          },
        ],
        stream: true,
      })) {
        // The synthetic HTTP 400 ends the stream after request serialization.
      }

      expect(requestBody).toMatchObject({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Read the attached PDF." },
              {
                type: "file",
                file: {
                  file_data: `data:application/pdf;base64,${base64}`,
                  filename: "contract.pdf",
                },
              },
            ],
          },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("OpenRouter tool schemas", () => {
  test("an optional field also admits null on the wire; a required one does not", () => {
    const request = adapter.requestFor({
      logger: resolveDebugOption(false),
      messages: [{ role: "user", content: "Delete the draft." }],
      model: "google/gemini-2.5-flash",
      tools: [
        {
          name: "delete_draft",
          description: "Delete a draft by name.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string" },
              note: { type: "string", minLength: 1 },
            },
            required: ["name"],
          },
        },
      ],
    });
    expect(request.tools).toMatchObject([
      {
        function: {
          parameters: {
            properties: {
              name: { type: "string" },
              note: { type: ["string", "null"], minLength: 1 },
            },
            required: ["name"],
          },
        },
      },
    ]);
  });
});
