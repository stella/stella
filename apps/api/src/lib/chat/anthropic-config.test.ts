import { EventType } from "@tanstack/ai";
import type { ChatMiddleware, ModelMessage } from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { createTestState } from "@stll/test-state";

import { env } from "@/api/env";
import { streamChatChunks } from "@/api/lib/chat/tanstack-chat-runtime";
import { isRecord } from "@/api/lib/type-guards";
import {
  cassetteFor,
  loadProviderWireCassettes,
} from "@/api/tests/helpers/provider-wire-cassette";
import { bodyBytesOf } from "@/api/tests/helpers/provider-wire-replay";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";

import { createTanStackTextAdapterFactory } from "../tanstack-ai-models";
import { anthropicWorkspaceHeaders } from "./anthropic-config";

const testFetchState = createTestFetch();

const testState = createTestState({ file: import.meta.path, config: env });

const ANTHROPIC_ADAPTER_PACKAGE = "@tanstack/ai-anthropic";

const unownedAnthropicTransport = (file: string, source: string) => {
  if (file === "lib/tanstack-ai-models.ts") {
    const constructors = source.match(/\banthropic\s*\([^;]*\)/gu) ?? [];
    return (
      source.match(/\bcreateAnthropicChat\b/gu)?.length !== 2 ||
      constructors.length !== 1 ||
      constructors.some(
        (call) =>
          !call.includes("anthropicClientOptions(anthropicWorkspaceId)"),
      )
    );
  }
  return (
    /import\s+(?!type\b)[^;]*?from\s+["'](?:@tanstack\/ai-anthropic|@anthropic-ai\/sdk)["']/u.test(
      source,
    ) ||
    /import\s*\(\s*["'](?:@tanstack\/ai-anthropic|@anthropic-ai\/sdk)["']\s*\)/u.test(
      source,
    )
  );
};

describe("Anthropic request configuration", () => {
  test("all production Anthropic transports are owned by the canonical stream factory", () => {
    const root = path.resolve(import.meta.dir, "../..");
    const violations: string[] = [];
    for (const file of new Bun.Glob("**/*.ts").scanSync({ cwd: root })) {
      if (
        file.includes(".test.") ||
        file.startsWith("tests/") ||
        file.includes(".fixtures.")
      ) {
        continue;
      }
      if (
        unownedAnthropicTransport(
          file,
          readFileSync(path.join(root, file), "utf-8"),
        )
      ) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

  test("the ownership census rejects a planted alternate transport", () => {
    // The specifier is interpolated so this file's own text holds no value
    // import of the adapter package for the repository's SDK boundary scan.
    expect(
      unownedAnthropicTransport(
        "lib/new-request.ts",
        `import { createAnthropicChat } from "${ANTHROPIC_ADAPTER_PACKAGE}";`,
      ),
    ).toBe(true);
    expect(
      unownedAnthropicTransport(
        "lib/new-request.ts",
        'import Anthropic from "@anthropic-ai/sdk";',
      ),
    ).toBe(true);
    expect(
      unownedAnthropicTransport(
        "lib/new-request.ts",
        'import type { AnthropicTextMetadata } from "@tanstack/ai-anthropic";',
      ),
    ).toBe(false);
  });

  test("the census rejects a constructor that omits shared client options", () => {
    const source = readFileSync(
      new URL("../tanstack-ai-models.ts", import.meta.url),
      "utf-8",
    );
    expect(unownedAnthropicTransport("lib/tanstack-ai-models.ts", source)).toBe(
      false,
    );
    const planted = source.replace(
      "anthropicClientOptions(anthropicWorkspaceId)",
      "{}",
    );
    expect(planted).not.toBe(source);
    expect(
      unownedAnthropicTransport("lib/tanstack-ai-models.ts", planted),
    ).toBe(true);
  });

  test("single-workspace keys do not acquire a workspace override", () => {
    expect(anthropicWorkspaceHeaders(undefined)).toEqual({});
  });

  for (const anthropicWorkspaceId of ["wrk_fixture", undefined]) {
    test(`the SDK sends the configured workspace on requests (${String(anthropicWorkspaceId)})`, async () => {
      const requests: Headers[] = [];
      const fetchSpy = Object.assign(
        mock(
          Object.assign(
            async (
              _url: Parameters<typeof globalThis.fetch>[0],
              init?: RequestInit,
            ) => {
              requests.push(new Headers(init?.headers));
              return new Response(
                JSON.stringify({
                  type: "error",
                  error: {
                    type: "invalid_request_error",
                    message: "Recorded transport stop",
                  },
                }),
                {
                  status: 400,
                  headers: { "content-type": "application/json" },
                },
              );
            },
            { preconnect: globalThis.fetch.preconnect },
          ),
        ),
        { preconnect: globalThis.fetch.preconnect },
      );
      testFetchState.set(fetchSpy);
      testState.setConfig("USE_MOCK_AI", false);
      try {
        const adapter = createTanStackTextAdapterFactory({
          provider: "anthropic",
          dataClass: "customer",
          apiKey: "sk-ant-usr-fixture",
          anthropicWorkspaceId,
        })("claude-sonnet-4-6");
        for await (const _chunk of adapter.chatStream({
          logger: resolveDebugOption(false),
          threadId: "workspace-header-test",
          messages: [{ role: "user", content: "Fixture" }],
          model: adapter.model,
        })) {
          // The synthetic response stops the SDK before any generation.
        }
        expect(requests).toHaveLength(1);
        expect(requests.at(0)?.get("anthropic-workspace-id")).toBe(
          anthropicWorkspaceId ?? null,
        );
      } finally {
        testFetchState.restore();
      }
    });
  }
});

test("Anthropic keeps the owned full tool and prompt lists across a successful continuation", async () => {
  const cassette = cassetteFor(
    loadProviderWireCassettes(),
    "anthropic",
    "text",
  );
  const exchange = cassette.exchanges.at(0);
  if (exchange === undefined) {
    throw new Error("Expected recorded Anthropic response");
  }
  const requests: { headers: Headers; body: Record<string, unknown> }[] = [];
  const fetch = Object.assign(
    async (
      _url: Parameters<typeof globalThis.fetch>[0],
      init?: RequestInit,
    ) => {
      if (typeof init?.body !== "string") {
        throw new TypeError("Expected serialized provider JSON");
      }
      const body: unknown = JSON.parse(init.body);
      if (!isRecord(body)) {
        throw new Error("Expected provider JSON object");
      }
      requests.push({ headers: new Headers(init.headers), body });
      return new Response(bodyBytesOf(exchange.response.body), {
        status: exchange.response.status,
        headers: exchange.response.headers,
      });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  testFetchState.set(fetch);
  testState.setConfig("USE_MOCK_AI", false);
  try {
    const adapter = createTanStackTextAdapterFactory({
      provider: "anthropic",
      dataClass: "customer",
      apiKey: "offline-test-key",
    })(cassette.model);
    expect(adapter.midConversationChannels).toBeUndefined();
    let messages: ModelMessage[] = [{ role: "user", content: "First request" }];
    const completed: string[] = [];
    const captureHistory: ChatMiddleware = {
      name: "capture-completed-history",
      onFinish: (ctx, info) => {
        messages = [...ctx.messages];
        completed.push(info.content);
      },
    };
    for (const names of [["lookup"], ["lookup", "inspect"]]) {
      for await (const chunk of streamChatChunks({
        adapter,
        threadId: "anthropic-policy-thread",
        runId: `policy-${names.length}`,
        messages,
        systemPrompts: [
          "Stable instructions",
          ...(names.length === 2 ? ["Additional instructions"] : []),
        ],
        tools: names.map((name) => ({
          name,
          description: name,
          inputSchema: { type: "object" as const, properties: {} },
        })),
        middleware: [captureHistory],
      })) {
        expect(chunk.type).not.toBe(EventType.RUN_ERROR);
      }
      messages.push({ role: "user", content: "Continue with the new tool" });
    }
    expect(completed).toEqual(["The cassette plays.", "The cassette plays."]);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.headers.get("anthropic-beta")).toBeNull();
      expect(JSON.stringify(request.body)).not.toContain(
        "__tanstack_deferred_placeholder__",
      );
      expect(JSON.stringify(request.body)).not.toContain("defer_loading");
      expect(JSON.stringify(request.body)).not.toContain("tool_addition");
    }
    expect(requests.at(0)?.body["tools"]).toMatchObject([{ name: "lookup" }]);
    expect(requests.at(1)?.body["tools"]).toMatchObject([
      { name: "lookup" },
      { name: "inspect" },
    ]);
    expect(requests.at(1)?.body["system"]).toMatchObject([
      { text: "Stable instructions" },
      { text: "Additional instructions" },
    ]);
    expect(requests.at(1)?.body["messages"]).toMatchObject([
      { role: "user" },
      { role: "assistant" },
      { role: "user" },
    ]);
  } finally {
    testFetchState.restore();
  }
});
