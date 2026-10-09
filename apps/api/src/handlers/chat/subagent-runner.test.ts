import { toolDefinition } from "@tanstack/ai";
import type { AnyTextAdapter } from "@tanstack/ai";
import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { createPipelineContext } from "@stll/anonymize";
import { AI_ERROR_KINDS } from "@stll/api-contract";
import { rejectionOf } from "@stll/property-testing/rejection";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { createScopedDb } from "@/api/db/scoped";
import { deanonymizeFromBoundary } from "@/api/handlers/chat/third-party-boundary";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import {
  applyChatToolPolicy,
  CHAT_TOOL_POLICY_KIND,
} from "@/api/handlers/chat/tools/tool-policy";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  admitModelDispatch,
  type ModelDispatchAdmission,
} from "@/api/lib/rate-limit/model-dispatch-admission";
import { resolveTanStackTextModel } from "@/api/lib/tanstack-ai-generate";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import { anonymizeTextFieldsWithDependencies } from "@/api/mcp/anonymization-core";
import { AnonymizedFieldBoundaryError } from "@/api/mcp/field-markers";
import {
  createRewritingAnonymizeDependencies,
  replaceFirstFieldDelimiterToken,
} from "@/api/tests/helpers/anonymize-pipeline-fakes";
import { createScriptedTextAdapter } from "@/api/tests/helpers/chat-round-trip";
import type { ScriptedTurn } from "@/api/tests/helpers/chat-round-trip";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";

import { runSubagent, subagentRunErrorMessage } from "./subagent-runner";
import type { RunSubagentOptions } from "./subagent-runner";

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

type RunScriptedSubagentOverrides = Partial<
  Pick<
    RunSubagentOptions,
    "systemSafe" | "systemUntrusted" | "thirdPartyBoundary"
  >
> & {
  /** Wraps the scripted transport, e.g. to record what the provider receives. */
  wrapAdapter?: ((adapter: AnyTextAdapter) => AnyTextAdapter) | undefined;
  admission?: ModelDispatchAdmission | undefined;
};

const runScriptedSubagent = async (
  turns: readonly ScriptedTurn[],
  overrides: RunScriptedSubagentOverrides = {},
) => {
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
  const scriptedAdapter = createScriptedTextAdapter(turns);
  const adapter = overrides.wrapAdapter
    ? overrides.wrapAdapter(scriptedAdapter)
    : scriptedAdapter;
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
      admission: overrides.admission ?? testModelAdmission(ids.orgA),
      orgAIConfig,
      managedAIResidency: "eu" as const,
      role: "fast",
      systemSafe: overrides.systemSafe ?? "Answer briefly.",
      systemUntrusted: overrides.systemUntrusted ?? "",
      tenantWorkspaceIds: [ids.wsA1],
      thirdPartyBoundary: overrides.thirdPartyBoundary ?? { type: "raw" },
      tools: { lookup: lookupTool },
    },
    {
      // The resolved model stays real; only its transport is scripted.
      resolveModel: async (options) =>
        asTestRaw<ResolvedTanStackTextModel>({
          ...(await resolveTanStackTextModel(options)),
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

describe("a subagent run under an anonymizing boundary", () => {
  // The safe half carries server constants such as the code-mode catalog's
  // function signatures; anonymizing it would brief the subagent with names
  // no tool answers to. Only the parent model's own text crosses the boundary.
  test("sends the safe half verbatim and anonymizes only the untrusted half", async () => {
    const systemSafe =
      "declare function external_lookup(query: string): Jan Novak;";
    const systemUntrusted = "Return output matching: Jan Novak";
    const boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }> = {
      anonymizationScopeId: "workspace-A",
      anonymizeFields: async ({ fields }) =>
        Result.ok({
          entityCount: fields.filter((field) => field.includes("Jan Novak"))
            .length,
          fields: fields.map((field) =>
            field.replaceAll("Jan Novak", "[PERSON_1]"),
          ),
          redactionMap: new Map([["[PERSON_1]", "Jan Novak"]]),
        }),
      excludedCanonicals: Promise.resolve([]),
      gazetteerEntries: Promise.resolve([]),
      literalPlaceholderAliases: new Map<string, string>(),
      historicalRedactionMap: new Map<string, string>(),
      organizationId: ids.orgA,
      pipelineContext: createPipelineContext(),
      placeholderOffsets: new Map<string, number>(),
      redactionMap: new Map<string, string>(),
      sourcePlaceholders: new Set<string>(),
      type: "anonymized",
    };
    const receivedSystemPrompts: unknown[] = [];

    const { result } = await runScriptedSubagent(
      [{ finishReason: "stop", text: "done", type: "text" }],
      {
        systemSafe,
        systemUntrusted,
        thirdPartyBoundary: boundary,
        wrapAdapter: (adapter) => ({
          ...adapter,
          chatStream: (options) => {
            receivedSystemPrompts.push(options.systemPrompts);
            return adapter.chatStream(options);
          },
        }),
      },
    );

    expect(result.outcome).toBe("completed");
    expect(receivedSystemPrompts).toEqual([
      [`${systemSafe}\n\nReturn output matching: [PERSON_1]`],
    ]);
  });
});

describe("a subagent run whose anonymization output lost its field structure", () => {
  test("fails before any provider request", async () => {
    const dependencies = createRewritingAnonymizeDependencies((text) =>
      replaceFirstFieldDelimiterToken(text, "[ORGANIZATION_1]"),
    );
    const boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }> = {
      anonymizationScopeId: "workspace-A",
      anonymizeFields: async (input) =>
        await anonymizeTextFieldsWithDependencies({ ...input, dependencies }),
      excludedCanonicals: Promise.resolve([]),
      gazetteerEntries: Promise.resolve([]),
      literalPlaceholderAliases: new Map<string, string>(),
      historicalRedactionMap: new Map<string, string>(),
      organizationId: ids.orgA,
      pipelineContext: createPipelineContext(),
      placeholderOffsets: new Map<string, number>(),
      redactionMap: new Map<string, string>(),
      sourcePlaceholders: new Set<string>(),
      type: "anonymized",
    };
    let providerRequests = 0;

    const run = runScriptedSubagent(
      [{ finishReason: "stop", text: "done", type: "text" }],
      {
        systemUntrusted: "Return output matching: Jan Novak",
        thirdPartyBoundary: boundary,
        wrapAdapter: (adapter) => ({
          ...adapter,
          chatStream: (options) => {
            providerRequests += 1;
            return adapter.chatStream(options);
          },
        }),
      },
    );

    const failure = await run.then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(HandlerError);
    if (!(failure instanceof HandlerError)) {
      return;
    }
    expect(failure.status).toBe(500);
    expect(failure.cause).toBeInstanceOf(AnonymizedFieldBoundaryError);
    expect(providerRequests).toBe(0);
  });
});

describe("a subagent request through the real anonymizer", () => {
  // A short deny-list name and an identifier-like run of letters and digits
  // sit at the edges of a field. The request must still be built, with every
  // field intact.
  test("is built with every field restorable when identifiers sit at field edges", async () => {
    const gazetteerEntry = (canonical: string) => ({
      canonical,
      createdAt: 0,
      id: `entry-${canonical}`,
      label: "organization",
      source: "manual" as const,
      variants: [],
      workspaceId: "workspace-A",
    });
    const boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }> = {
      anonymizationScopeId: "workspace-A",
      excludedCanonicals: Promise.resolve([]),
      gazetteerEntries: Promise.resolve([
        gazetteerEntry("Acme"),
        gazetteerEntry("Acme A"),
      ]),
      literalPlaceholderAliases: new Map<string, string>(),
      historicalRedactionMap: new Map<string, string>(),
      organizationId: ids.orgA,
      pipelineContext: createPipelineContext(),
      placeholderOffsets: new Map<string, number>(),
      redactionMap: new Map<string, string>(),
      sourcePlaceholders: new Set<string>(),
      type: "anonymized",
    };
    const systemSafe = "Answer briefly.";
    const systemUntrusted =
      "Acme A asks for the clause text for matter 9b57-eacfeca0f10b";
    const sent: { messages: string; systemPrompts: string }[] = [];

    const { result } = await runScriptedSubagent(
      [{ finishReason: "stop", text: "done", type: "text" }],
      {
        systemSafe,
        systemUntrusted,
        thirdPartyBoundary: boundary,
        wrapAdapter: (adapter) => ({
          ...adapter,
          chatStream: (options) => {
            sent.push({
              messages: JSON.stringify(options.messages),
              systemPrompts: JSON.stringify(options.systemPrompts),
            });
            return adapter.chatStream(options);
          },
        }),
      },
    );

    expect(result.outcome).toBe("completed");
    expect(sent).toHaveLength(1);
    const [request] = sent;
    // The fixture must reach the recognizers, or restoring would be trivial.
    expect(boundary.redactionMap.size).toBeGreaterThan(0);
    expect(
      deanonymizeFromBoundary({ boundary, text: request?.systemPrompts ?? "" }),
    ).toBe(JSON.stringify([`${systemSafe}\n\n${systemUntrusted}`]));
    expect(
      deanonymizeFromBoundary({ boundary, text: request?.messages ?? "" }),
    ).toContain("Find the termination clause");
  });
});

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

describe("a subagent run on its parent's admitted action", () => {
  test("stops when the admitted action's lease is lost", async () => {
    const lease = new AbortController();
    const reached = Promise.withResolvers<AbortSignal>();
    const run = admitModelDispatch({
      organizationId: ids.orgA,
      actionKind: "chat.send",
      signal: lease.signal,
      run: async (admission) =>
        await runScriptedSubagent(
          [{ finishReason: "stop", text: "never sent", type: "text" }],
          {
            admission,
            wrapAdapter: (adapter) => ({
              ...adapter,
              async *chatStream(options) {
                const signal = options.request?.signal;
                if (!signal) {
                  throw new Error(
                    "Expected the engine to pass an abort signal.",
                  );
                }
                reached.resolve(signal);
                const aborted = Promise.withResolvers<never>();
                signal.addEventListener(
                  "abort",
                  () => aborted.reject(signal.reason),
                  { once: true },
                );
                await aborted.promise;
                yield* adapter.chatStream(options);
              },
            }),
          },
        ),
    });

    const providerSignal = await reached.promise;
    expect(providerSignal.aborted).toBe(false);
    lease.abort();

    expect(await rejectionOf(run)).toMatchObject({ name: "AbortError" });
    expect(providerSignal.aborted).toBe(true);
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

  test("names a provider error by its kind, never by the provider's text", async () => {
    const sentinel = "SENTINEL_SUBAGENT_PROVIDER_TEXT";
    const { result } = await runScriptedSubagent([
      lookupStep,
      {
        code: `${sentinel}_code`,
        message: JSON.stringify({ error: { message: sentinel, code: 503 } }),
        type: "error",
      },
    ]);

    expect(result).toMatchObject({ outcome: "failed", reason: "run-error" });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(
      AI_ERROR_KINDS.map((kind) => subagentRunErrorMessage(kind)),
    ).toContain(result.outcome === "failed" ? result.message : "");
  });

  test("adds the usage a failed step reported to the steps before it", async () => {
    const { result } = await runScriptedSubagent([
      lookupStep,
      {
        code: "incomplete-stream",
        message: "The provider stream ended with an error.",
        type: "error",
        usage: ANSWER_STEP_USAGE,
      },
    ]);

    expect(result).toMatchObject({
      outcome: "failed",
      reason: "run-error",
      usage: { completionTokens: 45, promptTokens: 230, totalTokens: 275 },
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
