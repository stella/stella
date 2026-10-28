import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import { env } from "@/api/env";
import { createTestState } from "@/api/tests/helpers/test-state";

import { createTanStackTextAdapterFactory } from "../tanstack-ai-models";
import { anthropicWorkspaceHeaders } from "./anthropic-config";

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
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
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
              { status: 400, headers: { "content-type": "application/json" } },
            );
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      );
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
        fetchSpy.mockRestore();
      }
    });
  }
});

const nativeReasoningCases = [
  {
    name: "catalog-only adaptive thinking keeps the provider's default effort",
    effort: undefined,
    model: "claude-catalog-fixture",
    thinking: { type: "adaptive" },
    reasoning: undefined,
    mode: "stream",
    expectedThinking: { type: "adaptive" },
    expectedMaxTokens: 1024,
  },
  {
    name: "native thinking budgets raise the output ceiling",
    effort: undefined,
    model: "claude-sonnet-4-5",
    thinking: { type: "enabled", budget_tokens: 4096 },
    reasoning: undefined,
    mode: "stream",
    expectedThinking: { type: "enabled", budget_tokens: 4096 },
    expectedMaxTokens: 4097,
  },
  {
    name: "portable off takes precedence over native thinking",
    effort: "high",
    model: "claude-sonnet-4-5",
    thinking: { type: "enabled", budget_tokens: 4096 },
    reasoning: { level: "off", summary: false },
    mode: "stream",
    expectedThinking: { type: "disabled" },
    expectedMaxTokens: 1024,
  },
  {
    name: "forced structured-output tools omit native thinking",
    effort: "high",
    model: "claude-sonnet-4-5",
    thinking: { type: "enabled", budget_tokens: 4096 },
    reasoning: undefined,
    mode: "structured",
    expectedThinking: undefined,
    expectedMaxTokens: 1024,
  },
] as const;

for (const scenario of nativeReasoningCases) {
  test(scenario.name, async () => {
    const requests: unknown[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (
          _url: Parameters<typeof globalThis.fetch>[0],
          init?: RequestInit,
        ) => {
          if (typeof init?.body !== "string") {
            throw new TypeError("Expected the SDK's JSON request body");
          }
          requests.push(JSON.parse(init.body));
          return new Response(
            JSON.stringify({
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "Recorded transport stop",
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    testState.setConfig("USE_MOCK_AI", false);
    try {
      const adapter = createTanStackTextAdapterFactory({
        provider: "anthropic",
        dataClass: "customer",
        apiKey: "sk-ant-usr-fixture",
      })(scenario.model);
      const chatOptions = {
        logger: resolveDebugOption(false),
        messages: [{ role: "user" as const, content: "Fixture" }],
        model: adapter.model,
        modelOptions: {
          thinking: scenario.thinking,
          max_tokens: 1024,
          ...(scenario.effort === undefined
            ? {}
            : { output_config: { effort: scenario.effort } }),
        },
        ...(scenario.reasoning === undefined
          ? {}
          : { reasoning: scenario.reasoning }),
      };
      if (scenario.mode === "structured") {
        await rejectionOf(
          adapter.structuredOutput({
            chatOptions,
            outputSchema: {
              type: "object",
              properties: { answer: { type: "string" } },
            },
          }),
        );
      } else {
        for await (const _chunk of adapter.chatStream(chatOptions)) {
          // The recorded request stops before generation.
        }
      }
      expect(requests).toHaveLength(1);
      expect(requests.at(0)).toMatchObject({
        max_tokens: scenario.expectedMaxTokens,
      });
      if (scenario.expectedThinking === undefined) {
        expect(requests.at(0)).not.toHaveProperty("thinking");
      } else {
        expect(requests.at(0)).toMatchObject({
          thinking: scenario.expectedThinking,
        });
      }
      expect(requests.at(0)).not.toHaveProperty("output_config");
    } finally {
      fetchSpy.mockRestore();
    }
  });
}
