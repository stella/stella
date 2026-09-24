import { toolDefinition } from "@tanstack/ai";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { createScopedDb } from "@/api/db/scoped";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import {
  applyChatToolPolicy,
  CHAT_TOOL_POLICY_KIND,
} from "@/api/handlers/chat/tools/tool-policy";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { resolveTanStackTextModel } from "@/api/lib/tanstack-ai-generate";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import { createScriptedTextAdapter } from "@/api/tests/helpers/chat-round-trip";
import type { ScriptedTurn } from "@/api/tests/helpers/chat-round-trip";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";

import { runSubagent } from "./subagent-runner";

// Drives `runSubagent` through the real `chat()` loop with a scripted provider,
// so every step boundary (one RUN_FINISHED per provider iteration) and every
// terminal reason is the SDK's own emission, and usage metering writes to the
// fixture database.

const orgAIConfig = {
  providers: [{ provider: "openai", apiKey: "test-api-key" }],
  overrideModels: {
    chat: { provider: "openai", modelId: "gpt-5.4-mini" },
    fast: { provider: "openai", modelId: "gpt-5.4-nano" },
    pdf: { provider: "openai", modelId: "gpt-5.4" },
    reasoning: { provider: "openai", modelId: "gpt-5.4" },
  },
  decision: null,
} satisfies OrgAIConfig;

const LOOKUP_STEP_USAGE = {
  completionTokens: 5,
  promptTokens: 100,
  totalTokens: 105,
};
const ANSWER_STEP_USAGE = {
  completionTokens: 40,
  promptTokens: 130,
  totalTokens: 170,
};

let ids: TestIds;
let safeDb: SafeDb;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  ids = fixture.ids;
  safeDb = toSafeDbMock(
    asTestRaw<ScopedDb>(
      createScopedDb(fixture.testDb, [ids.wsA1], ids.orgA, ids.userA1),
    ),
  );
});

afterAll(async () => {
  await releaseRlsFixture();
});

const runScriptedSubagent = async (turns: readonly ScriptedTurn[]) => {
  const lookups: string[] = [];
  const lookupTool = applyChatToolPolicy(
    toolDefinition({
      name: "lookup",
      description: "Look up a clause",
      inputSchema: toTanStackToolSchema(v.object({ query: v.string() })),
    }).server(async ({ query }) => {
      lookups.push(query);
      return await Promise.resolve({ clause: "Termination for convenience" });
    }),
    CHAT_TOOL_POLICY_KIND.internal,
  );
  const adapter = createScriptedTextAdapter(turns);
  const result = await runSubagent(
    {
      abortSignal: new AbortController().signal,
      delegationDepth: 1,
      maxSteps: 4,
      messages: [
        {
          id: "subagent-task",
          parts: [{ content: "Find the termination clause", type: "text" }],
          role: "user",
        },
      ],
      metering: {
        feature: "subagent",
        safeDb,
        serviceTier: "standard",
        sessionId: Bun.randomUUIDv7(),
        traceId: Bun.randomUUIDv7(),
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      },
      organizationId: ids.orgA,
      orgAIConfig,
      role: "fast",
      system: "Answer briefly.",
      tenantWorkspaceIds: [ids.wsA1],
      thirdPartyBoundary: { type: "raw" },
      tools: { lookup: lookupTool },
    },
    {
      // The resolved model stays real; only its transport is scripted.
      resolveModel: (options) =>
        asTestRaw<ResolvedTanStackTextModel>({
          ...resolveTanStackTextModel(options),
          adapter,
        }),
    },
  );
  return { lookups, result };
};

const lookupStep = {
  arguments: JSON.stringify({ query: "termination" }),
  toolName: "lookup",
  type: "tool-call",
  usage: LOOKUP_STEP_USAGE,
} as const satisfies ScriptedTurn;

describe("a subagent run across several model steps", () => {
  test("reports the usage of every step, not only the last", async () => {
    const { lookups, result } = await runScriptedSubagent([
      lookupStep,
      {
        finishReason: "stop",
        text: "Clause 12 allows termination for convenience.",
        type: "text",
        usage: ANSWER_STEP_USAGE,
      },
    ]);

    // The fixture must span two provider steps, or a last-step-only reading
    // would pass the usage assertion below.
    expect(lookups).toEqual(["termination"]);
    expect(result).toMatchObject({
      outcome: "completed",
      text: "Clause 12 allows termination for convenience.",
      usage: {
        completionTokens: 45,
        promptTokens: 230,
        totalTokens: 275,
      },
    });
  });
});

describe("a subagent run that ends without a complete answer", () => {
  test("reports a provider error as a failure, keeping the usage spent before it", async () => {
    const { result } = await runScriptedSubagent([
      lookupStep,
      { code: "overloaded", message: "Provider overloaded", type: "error" },
    ]);

    expect(result).toMatchObject({
      outcome: "failed",
      reason: "run-error",
      usage: LOOKUP_STEP_USAGE,
    });
  });

  test("reports an answer cut at the length limit as truncated, not as a result", async () => {
    const { result } = await runScriptedSubagent([
      lookupStep,
      {
        finishReason: "length",
        text: "Clause 12 allows termi",
        type: "text",
        usage: ANSWER_STEP_USAGE,
      },
    ]);

    expect(result).toMatchObject({
      outcome: "failed",
      reason: "length",
      usage: { completionTokens: 45, promptTokens: 230, totalTokens: 275 },
    });
  });

  test("reports a content-filtered answer as filtered, not as a result", async () => {
    const { result } = await runScriptedSubagent([
      { finishReason: "content_filter", text: "", type: "text" },
    ]);

    expect(result).toMatchObject({
      outcome: "failed",
      reason: "content_filter",
    });
  });

  test("reports a run that used every step on tool calls as out of steps", async () => {
    const { lookups, result } = await runScriptedSubagent([
      lookupStep,
      lookupStep,
      lookupStep,
      lookupStep,
    ]);

    expect(lookups).toHaveLength(4);
    expect(result).toMatchObject({
      outcome: "failed",
      reason: "tool_calls",
    });
  });
});
