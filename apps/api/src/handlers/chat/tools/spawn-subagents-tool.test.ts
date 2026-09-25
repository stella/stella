import { toolDefinition } from "@tanstack/ai";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { env } from "@/api/env";
import type {
  RunSubagentOptions,
  RunSubagentResult,
} from "@/api/handlers/chat/subagent-runner";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import {
  CHAT_CODE_MODE_SYSTEM_PROMPT,
  CODE_MODE_EXECUTE_TOOL_NAME,
} from "@/api/handlers/chat/tools/execute/chat-code-mode";
import {
  createSpawnSubagentsTool,
  resolveValidatedSubagentModelId,
} from "@/api/handlers/chat/tools/spawn-subagents-tool";
import type { SubagentProposalSink } from "@/api/handlers/chat/tools/subagent-tool-shared";
import { toSafeId } from "@/api/lib/branded-types";
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import { UsageLimitExceededError } from "@/api/lib/errors/tagged-errors";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// `spawn-subagents-tool.ts` calls `runSubagent` (a real provider/model call
// with its own metering side effects) and `assertUsageAvailable` (a real DB
// read). Both are mocked at the module boundary so these tests exercise the
// tool's own dispatch/pre-flight logic without a live model or database —
// same seam every other chat-tool test in this directory uses (see
// `template-tools.test.ts`, `subagent-tools.test.ts`).

type RunSubagentCall = RunSubagentOptions;

const runSubagentCalls: RunSubagentCall[] = [];
let runSubagentImpl: (
  options: RunSubagentOptions,
) => Promise<RunSubagentResult> = async () => ({
  outcome: "completed",
  text: "done",
  usage: undefined,
});

const runSubagentForTest = async (options: RunSubagentOptions) => {
  runSubagentCalls.push(options);
  return await runSubagentImpl(options);
};

type AssertUsageAvailableArgs = {
  organizationId: string;
  required: number;
};

const assertUsageAvailableCalls: AssertUsageAvailableArgs[] = [];
let nextAssertUsageAvailableResult:
  | { ok: true; available: number }
  | { ok: false; error: UsageLimitExceededError } = {
  ok: true,
  available: 1000,
};

const assertUsageAvailableForTest = async ({
  organizationId,
  required,
}: AssertUsageAvailableArgs) => {
  assertUsageAvailableCalls.push({ organizationId, required });
  return await Promise.resolve(nextAssertUsageAvailableResult);
};

describe("resolveValidatedSubagentModelId", () => {
  test("returns undefined when no override is supplied", () => {
    const modelId = resolveValidatedSubagentModelId({
      subModel: undefined,
      modelInfo: {
        keySource: "instance",
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      },
    });

    expect(modelId).toBeUndefined();
  });

  test("rejects a provider-qualified override ('provider::model') even under BYOK", () => {
    const modelId = resolveValidatedSubagentModelId({
      subModel: "openrouter::google/gemini-3.5-flash",
      modelInfo: {
        keySource: "byok",
        provider: "anthropic",
        modelId: "claude-haiku-4-5-20251001",
      },
    });

    expect(modelId).toBeUndefined();
  });

  test("accepts a BYOK override that is in the provider's curated catalog", () => {
    const modelId = resolveValidatedSubagentModelId({
      subModel: "claude-sonnet-4-6",
      modelInfo: {
        keySource: "byok",
        provider: "anthropic",
        modelId: "claude-haiku-4-5-20251001",
      },
    });

    expect(modelId).toBe("claude-sonnet-4-6");
  });

  test("rejects a BYOK override that is not in the provider's curated catalog", () => {
    const modelId = resolveValidatedSubagentModelId({
      // A real model id, but from a different provider's catalog.
      subModel: "gpt-5.4-nano",
      modelInfo: {
        keySource: "byok",
        provider: "anthropic",
        modelId: "claude-haiku-4-5-20251001",
      },
    });

    expect(modelId).toBeUndefined();
  });

  test("accepts an instance override that matches the configured model exactly", () => {
    const modelId = resolveValidatedSubagentModelId({
      subModel: "claude-sonnet-4-6",
      modelInfo: {
        keySource: "instance",
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      },
    });

    expect(modelId).toBe("claude-sonnet-4-6");
  });

  test("rejects an instance override that does not match the configured model", () => {
    const modelId = resolveValidatedSubagentModelId({
      subModel: "claude-opus-4-8",
      modelInfo: {
        keySource: "instance",
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      },
    });

    expect(modelId).toBeUndefined();
  });
});

const organizationId = toSafeId<"organization">(
  "019e7000-0000-7000-8000-000000000010",
);
const userId = toSafeId<"user">("019e7000-0000-7000-8000-000000000011");
const threadId = toSafeId<"chatThread">("019e7000-0000-7000-8000-000000000012");
const rawBoundary: ChatThirdPartyBoundary = { type: "raw" };

/** Runs `fn` against a stub `Transaction` — real content doesn't matter
 *  since `assertUsageAvailable` is mocked above and never reads it. */
const passthroughSafeDb: SafeDb = async (fn) =>
  Result.ok(await fn(asTestRaw<Transaction>({})));

const buildTool = (
  buildSubagentToolset: (
    sink: SubagentProposalSink,
  ) => ChatToolMap = (): ChatToolMap => ({}),
) => {
  const tools = createSpawnSubagentsTool({
    buildSubagentToolset,
    organizationId,
    orgAIConfig: null,
    safeDb: passthroughSafeDb,
    userId,
    workspaceId: null,
    threadId,
    delegationDepth: 0,
    thirdPartyBoundary: rawBoundary,
    dependencies: {
      assertUsageAvailable: assertUsageAvailableForTest,
      runSubagent: runSubagentForTest,
    },
  });
  // SAFETY: test invokes the server tool's execute directly with a stub
  // call context, same pattern as template-tools.test.ts.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return tools.spawn_subagents.execute as unknown as (
    input: { subagents: { task: string }[] },
    ctx: { abortSignal?: AbortSignal },
  ) => Promise<{
    results: {
      index: number;
      status: string;
      result?: string;
      error?: string;
    }[];
  }>;
};

describe("createSpawnSubagentsTool — batch usage pre-flight", () => {
  test("dispatches every subagent when the batch fits the org's remaining balance", async () => {
    const previousEnforcement = env.USAGE_ENFORCEMENT_ENABLED;
    const previousProvider = env.AI_PROVIDER;
    const previousAnthropicKey = env.ANTHROPIC_API_KEY;
    env.USAGE_ENFORCEMENT_ENABLED = true;
    env.AI_PROVIDER = "anthropic";
    env.ANTHROPIC_API_KEY = "sk-test";
    runSubagentCalls.length = 0;
    assertUsageAvailableCalls.length = 0;
    nextAssertUsageAvailableResult = { ok: true, available: 1000 };
    runSubagentImpl = async () => ({
      outcome: "completed",
      text: "subtask done",
      usage: undefined,
    });

    try {
      const execute = buildTool();
      const result = await execute(
        { subagents: [{ task: "a" }, { task: "b" }, { task: "c" }] },
        {},
      );

      // Non-BYOK "fast" role, standard tier: computeUsageUnitCost({actionType:
      // "subagent", serviceTier: "standard", isByok: false}) === 2 per
      // subtask, so the batch of 3 must request 6 units — one pre-flight
      // check for the whole call, not per-subagent.
      expect(assertUsageAvailableCalls).toEqual([
        { organizationId, required: 6 },
      ]);
      expect(runSubagentCalls).toHaveLength(3);
      expect(result.results).toHaveLength(3);
      for (const entry of result.results) {
        expect(entry.status).toBe("completed");
      }
    } finally {
      env.USAGE_ENFORCEMENT_ENABLED = previousEnforcement;
      env.AI_PROVIDER = previousProvider;
      env.ANTHROPIC_API_KEY = previousAnthropicKey;
    }
  });

  test("rejects the whole batch with a structured error and dispatches nothing when the org is over its cap", async () => {
    const previousEnforcement = env.USAGE_ENFORCEMENT_ENABLED;
    const previousProvider = env.AI_PROVIDER;
    const previousAnthropicKey = env.ANTHROPIC_API_KEY;
    env.USAGE_ENFORCEMENT_ENABLED = true;
    env.AI_PROVIDER = "anthropic";
    env.ANTHROPIC_API_KEY = "sk-test";
    runSubagentCalls.length = 0;
    assertUsageAvailableCalls.length = 0;
    nextAssertUsageAvailableResult = {
      ok: false,
      error: new UsageLimitExceededError({
        message: "Usage limit exceeded: need 6, have 1",
        required: 6,
        available: 1,
        reason: "usage_limit_exceeded",
      }),
    };
    runSubagentImpl = async () => ({
      outcome: "completed",
      text: "should never run",
      usage: undefined,
    });

    try {
      const execute = buildTool();
      const result = await execute(
        { subagents: [{ task: "a" }, { task: "b" }, { task: "c" }] },
        {},
      );

      // No provider calls and no usage events: `runSubagent` (the only place
      // that writes `recordUsageEvent({ actionType: "subagent" })`) is never
      // invoked when the batch pre-flight rejects.
      expect(runSubagentCalls).toHaveLength(0);
      expect(result.results).toHaveLength(3);
      for (const [index, entry] of result.results.entries()) {
        expect(entry).toEqual({
          index,
          status: "failed",
          error: "Usage limit exceeded: need 6, have 1",
        });
      }
    } finally {
      env.USAGE_ENFORCEMENT_ENABLED = previousEnforcement;
      env.AI_PROVIDER = previousProvider;
      env.ANTHROPIC_API_KEY = previousAnthropicKey;
    }
  });

  test("skips the pre-flight entirely (and never reads the ledger) when usage enforcement is disabled", async () => {
    const previousEnforcement = env.USAGE_ENFORCEMENT_ENABLED;
    const previousProvider = env.AI_PROVIDER;
    const previousAnthropicKey = env.ANTHROPIC_API_KEY;
    env.USAGE_ENFORCEMENT_ENABLED = false;
    env.AI_PROVIDER = "anthropic";
    env.ANTHROPIC_API_KEY = "sk-test";
    runSubagentCalls.length = 0;
    assertUsageAvailableCalls.length = 0;
    runSubagentImpl = async () => ({
      outcome: "completed",
      text: "ok",
      usage: undefined,
    });

    try {
      const execute = buildTool();
      const result = await execute({ subagents: [{ task: "a" }] }, {});

      expect(assertUsageAvailableCalls).toHaveLength(0);
      expect(runSubagentCalls).toHaveLength(1);
      expect(result.results[0]?.status).toBe("completed");
    } finally {
      env.USAGE_ENFORCEMENT_ENABLED = previousEnforcement;
      env.AI_PROVIDER = previousProvider;
      env.ANTHROPIC_API_KEY = previousAnthropicKey;
    }
  });
});

describe("createSpawnSubagentsTool — subagent system prompt", () => {
  const runWithToolset = async (
    toolset: ChatToolMap,
    subagent?: { task: string; expectedOutput?: string },
  ) => {
    const previousEnforcement = env.USAGE_ENFORCEMENT_ENABLED;
    const previousProvider = env.AI_PROVIDER;
    const previousAnthropicKey = env.ANTHROPIC_API_KEY;
    env.USAGE_ENFORCEMENT_ENABLED = false;
    env.AI_PROVIDER = "anthropic";
    env.ANTHROPIC_API_KEY = "sk-test";
    runSubagentCalls.length = 0;
    runSubagentImpl = async () => ({
      outcome: "completed",
      text: "done",
      usage: undefined,
    });
    try {
      await buildTool(() => toolset)(
        { subagents: [subagent ?? { task: "a" }] },
        {},
      );
      const call = runSubagentCalls.at(0);
      if (call === undefined) {
        throw new Error("The tool did not run a subagent");
      }
      return {
        systemSafe: call.systemSafe,
        systemUntrusted: call.systemUntrusted,
      };
    } finally {
      env.USAGE_ENFORCEMENT_ENABLED = previousEnforcement;
      env.AI_PROVIDER = previousProvider;
      env.ANTHROPIC_API_KEY = previousAnthropicKey;
    }
  };

  // `execute_typescript` declares `list_matters` only in this section and
  // `discover_tools` lists only lazy reads, so a subagent without it cannot
  // list matters. The catalog rides on the safe half: an anonymizing boundary
  // would otherwise rewrite its function signatures.
  test("carries the code-mode catalog on the safe half when the toolset has execute_typescript", async () => {
    const executeTypescript = toolDefinition({
      name: CODE_MODE_EXECUTE_TOOL_NAME,
      description: "Run code.",
    }).server(async () => "ok");

    const { systemSafe, systemUntrusted } = await runWithToolset({
      [CODE_MODE_EXECUTE_TOOL_NAME]: executeTypescript,
    });
    expect(systemSafe).toContain(CHAT_CODE_MODE_SYSTEM_PROMPT);
    expect(systemUntrusted).toBe("");
  });

  test("omits the code-mode catalog when the toolset has no execute_typescript", async () => {
    const { systemSafe } = await runWithToolset({});
    expect(systemSafe).not.toContain(CHAT_CODE_MODE_SYSTEM_PROMPT);
  });

  // The shape hint is the parent model's own text, so it must cross the
  // third-party boundary rather than ride verbatim with the framing.
  test("puts the parent model's expected-output brief on the untrusted half", async () => {
    const { systemSafe, systemUntrusted } = await runWithToolset(
      {},
      { task: "a", expectedOutput: "a table of matters" },
    );
    expect(systemUntrusted).toContain("a table of matters");
    expect(systemSafe).not.toContain("a table of matters");
  });
});

describe("createSpawnSubagentsTool — abort propagation", () => {
  test("rejects with AbortError and reports no results when the parent signal aborts mid-run", async () => {
    const previousEnforcement = env.USAGE_ENFORCEMENT_ENABLED;
    const previousProvider = env.AI_PROVIDER;
    const previousAnthropicKey = env.ANTHROPIC_API_KEY;
    env.USAGE_ENFORCEMENT_ENABLED = false;
    env.AI_PROVIDER = "anthropic";
    env.ANTHROPIC_API_KEY = "sk-test";
    runSubagentCalls.length = 0;

    const abortError = new Error("Subagent run was aborted.");
    abortError.name = "AbortError";

    // One subagent finishes normally, the other observes the parent abort
    // and throws AbortError — mirrors `runSubagent` in
    // `subagent-runner.ts`, which throws AbortError once
    // `abortController.signal.aborted` is true.
    runSubagentImpl = async (options) => {
      if (options.messages[0]?.parts[0]?.type === "text") {
        const text = options.messages[0].parts[0].content;
        if (text === "aborts") {
          throw abortError;
        }
      }
      return {
        outcome: "completed",
        text: "finished before abort",
        usage: undefined,
      };
    };

    try {
      const execute = buildTool();

      const outcome = await Result.tryPromise(
        async () =>
          await execute(
            { subagents: [{ task: "finishes" }, { task: "aborts" }] },
            {},
          ),
      );

      // The whole tool call must reject with the AbortError — a resolved
      // Result here would mean partial results were reported as success.
      expect(Result.isError(outcome)).toBe(true);
      if (Result.isError(outcome)) {
        expect(outcome.error.cause).toBe(abortError);
      }
    } finally {
      env.USAGE_ENFORCEMENT_ENABLED = previousEnforcement;
      env.AI_PROVIDER = previousProvider;
      env.ANTHROPIC_API_KEY = previousAnthropicKey;
    }
  });
});

describe("createSpawnSubagentsTool — incomplete subagent runs", () => {
  test("reports a run without a complete answer as a failed subtask, not as a finding", async () => {
    const previousEnforcement = env.USAGE_ENFORCEMENT_ENABLED;
    const previousProvider = env.AI_PROVIDER;
    const previousAnthropicKey = env.ANTHROPIC_API_KEY;
    env.USAGE_ENFORCEMENT_ENABLED = false;
    env.AI_PROVIDER = "anthropic";
    env.ANTHROPIC_API_KEY = "sk-test";
    const cutOff =
      "The subagent's answer was cut off at the model's output limit.";
    runSubagentImpl = async () => ({
      message: cutOff,
      outcome: "failed",
      reason: "length",
      usage: undefined,
    });

    try {
      const execute = buildTool();
      const result = await execute({ subagents: [{ task: "a" }] }, {});

      expect(result.results).toEqual([
        { error: cutOff, index: 0, status: "failed" },
      ]);
    } finally {
      env.USAGE_ENFORCEMENT_ENABLED = previousEnforcement;
      env.AI_PROVIDER = previousProvider;
      env.ANTHROPIC_API_KEY = previousAnthropicKey;
    }
  });

  test("keeps the writes a run proposed before it stopped short", async () => {
    const previousEnforcement = env.USAGE_ENFORCEMENT_ENABLED;
    const previousProvider = env.AI_PROVIDER;
    const previousAnthropicKey = env.ANTHROPIC_API_KEY;
    env.USAGE_ENFORCEMENT_ENABLED = false;
    env.AI_PROVIDER = "anthropic";
    env.ANTHROPIC_API_KEY = "sk-test";
    const cutOff =
      "The subagent's answer was cut off at the model's output limit.";
    let sink: SubagentProposalSink | undefined;
    runSubagentImpl = async () => {
      sink?.record({ toolName: "update_field", args: { value: "x" } });
      return {
        message: cutOff,
        outcome: "failed",
        reason: "length",
        usage: undefined,
      };
    };

    try {
      const execute = buildTool((proposalSink) => {
        sink = proposalSink;
        return {};
      });
      const result = await execute({ subagents: [{ task: "a" }] }, {});

      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({ index: 0, status: "failed" });
      expect(result.results[0]?.error).toStartWith(cutOff);
      expect(result.results[0]?.error).toContain(
        '1. update_field {"value":"x"}',
      );
    } finally {
      env.USAGE_ENFORCEMENT_ENABLED = previousEnforcement;
      env.AI_PROVIDER = previousProvider;
      env.ANTHROPIC_API_KEY = previousAnthropicKey;
    }
  });
});
