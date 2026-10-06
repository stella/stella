import { EventType } from "@tanstack/ai";
import type { AnyTextAdapter, StreamChunk } from "@tanstack/ai";
import { Result } from "better-result";
import { beforeEach, describe, expect, test } from "bun:test";

import type { Fetcher } from "@stll/fetch";
import { listSkillMetadata, readSkillRequiredTools } from "@stll/skills";

import type { SafeDb } from "@/api/db/safe-db";
import { env } from "@/api/env";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { toSafeId } from "@/api/lib/branded-types";
import {
  buildAiConditionDecider,
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/lib/docx/ai-field-generator";
import { admitModelDispatch } from "@/api/lib/rate-limit/model-dispatch-admission";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import { resolveDecisionModel } from "@/api/lib/workflow/decisions/decision-model";
import type { DecisionModel } from "@/api/lib/workflow/decisions/decision-model";
import { createSystemOneClient } from "@/api/lib/workflow/decisions/system-one";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";

// The real `chat()` engine runs here; only the provider boundary is faked, so
// a fixture cannot invent chunk shapes the engine never emits. Each request the
// engine dispatches is captured so we can assert whether the skill tools were
// wired and how the prompt was assembled. Text drafting reaches the adapter
// through `chatStream`; the occurrence adapter asks for structured output, and
// with no skill tools the engine skips the agent loop and calls
// `structuredOutput` alone.
type CapturedRequest = {
  /** The request's output ceiling, as the provider receives it. */
  maxOutputTokens: number | undefined;
  prompt: string | undefined;
  toolNames: string[];
};

const capturedRequests: CapturedRequest[] = [];

// The test model is OpenAI-shaped, so `mergeGenerationOptions` writes the
// budget as `max_output_tokens`; reading it here asserts what the provider was
// actually told, not what the generator intended.
const readMaxOutputTokens = (modelOptions: unknown): number | undefined => {
  if (typeof modelOptions !== "object" || modelOptions === null) {
    return undefined;
  }
  const value: unknown = Reflect.get(modelOptions, "max_output_tokens");
  return typeof value === "number" ? value : undefined;
};

const captureRequest = ({
  messages,
  modelOptions,
  tools,
}: {
  messages?: readonly { content?: unknown }[] | undefined;
  modelOptions?: unknown;
  tools?: readonly { name: string }[] | undefined;
}): void => {
  const content = messages?.at(0)?.content;
  capturedRequests.push({
    maxOutputTokens: readMaxOutputTokens(modelOptions),
    prompt: typeof content === "string" ? content : undefined,
    toolNames: (tools ?? []).map((tool) => tool.name),
  });
};

const DRAFTED_VALUE = "drafted value";
const ADAPTED_RENDERINGS = { renderings: ["adapted"] };
const CONDITION_DECISION = { decision: true };
/** The two structured-output callers ask for different shapes through the one
 *  adapter, and each parses its answer strictly, so the fake answers the shape
 *  the prompt asked for rather than one shape for both. */
const structuredAnswerFor = (prompt: string | undefined): object =>
  prompt?.includes("one yes/no condition") === true
    ? CONDITION_DECISION
    : ADAPTED_RENDERINGS;
/** A Polish scope paragraph the provider stops writing mid-word, which is what
 *  reaching the output ceiling looks like from the caller's side. */
const CUT_VALUE =
  "Reprezentowanie we wszystkich sprawach faktycznych i prawnych związ";

/** How the provider ends each successive run. The last entry repeats, so a
 *  single-entry script answers every call the same way. */
type RunScript = readonly {
  finishReason: "length" | "stop";
  text: string;
}[];

const COMPLETE_RUN: RunScript = [{ finishReason: "stop", text: DRAFTED_VALUE }];

/**
 * A real `AnyTextAdapter` the engine drives exactly as it drives a provider;
 * only the wire answers are scripted, so a fixture cannot invent chunk shapes
 * the engine never emits.
 */
const scriptedAdapter = (script: RunScript): AnyTextAdapter => {
  let call = 0;
  return {
    kind: "text",
    name: "field-generator",
    model: "test-model",
    "~types": {
      providerOptions: {},
      inputModalities: ["text"],
      messageMetadataByModality: {},
      toolCapabilities: [],
      toolCallMetadata: {},
      systemPromptMetadata: undefined,
    },
    async *chatStream(options) {
      captureRequest(options);
      const run = script.at(call) ?? script.at(-1);
      call += 1;
      if (run === undefined) {
        throw new Error("Expected a scripted run for this call.");
      }
      const messageId = `provider-message-${String(call)}`;
      yield {
        type: EventType.RUN_STARTED,
        runId: "run-1",
        threadId: "thread-1",
      } satisfies StreamChunk;
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
      } satisfies StreamChunk;
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: run.text,
      } satisfies StreamChunk;
      yield {
        type: EventType.TEXT_MESSAGE_END,
        messageId,
      } satisfies StreamChunk;
      yield {
        type: EventType.RUN_FINISHED,
        finishReason: run.finishReason,
        runId: "run-1",
        threadId: "thread-1",
      } satisfies StreamChunk;
    },
    structuredOutput: async ({ chatOptions }) => {
      captureRequest(chatOptions);
      const data = structuredAnswerFor(lastRequest().prompt);
      return { data, rawText: JSON.stringify(data) };
    },
  };
};

// SAFETY: `adapter` is a real `AnyTextAdapter` the engine drives exactly as it
// drives a provider; the remaining fields are bookkeeping these generators
// never route through a provider.
const modelWith = (script: RunScript) =>
  ({
    adapter: scriptedAdapter(script),
    keySource: "instance",
    modelId: "test-model",
    modelOptions: {},
    provider: "openai",
  }) as ResolvedTanStackTextModel;

const resolveTextModel = async () => modelWith(COMPLETE_RUN);

/** A provider that answers nothing until its run is aborted, reporting the
 *  signal it was handed once the engine reaches it. */
const blockingModel = (reached: PromiseWithResolvers<AbortSignal>) => {
  const model = modelWith(COMPLETE_RUN);
  const adapter: AnyTextAdapter = {
    ...model.adapter,
    async *chatStream(options) {
      const signal = options.request?.signal;
      if (!signal) {
        throw new Error("Expected the engine to pass an abort signal.");
      }
      reached.resolve(signal);
      const aborted = Promise.withResolvers<never>();
      signal.addEventListener("abort", () => aborted.reject(signal.reason), {
        once: true,
      });
      await aborted.promise;
      yield {
        type: EventType.RUN_STARTED,
        runId: "run-1",
        threadId: "thread-1",
      } satisfies StreamChunk;
    },
  };
  return { ...model, adapter };
};

/** Model resolution that hands every call of one generator the same scripted
 *  adapter, so a retry sees the next scripted run rather than a fresh script. */
const resolveScriptedModel = (script: RunScript) => {
  const model = modelWith(script);
  return async () => model;
};

beforeEach(() => {
  capturedRequests.length = 0;
});

// SAFETY: only used as a non-null truthiness gate in the builders; the model is
// injected through `resolveTextModel`, so the config's contents are never read.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const orgAIConfig = {} as OrgAIConfig;
const organizationId = toSafeId<"organization">("org_test");
const userId = toSafeId<"user">("user_test");
// SAFETY: every query answers with no rows, so only built-in skills are in
// the catalog, and no scripted run calls a skill tool.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const safeDb = (async () => Result.ok([])) as unknown as SafeDb;
const skillContext = { organizationId, safeDb, userId };

const SKILL_REF_PROMPT =
  "Draft this clause [POA scope](#stella-skill-ref=poa-drafting).";
const PLAIN_PROMPT = "Draft the scope of this power of attorney.";

// The generators report model failures rather than throwing, so an absent
// request has to fail loudly rather than read as "no tools were advertised".
const lastRequest = (): CapturedRequest => {
  const captured = capturedRequests.at(-1);
  if (!captured) {
    throw new Error("Expected the generator to reach the provider adapter.");
  }
  return captured;
};
const requestAt = (index: number): CapturedRequest => {
  const captured = capturedRequests.at(index);
  if (!captured) {
    throw new Error(
      `Expected at least ${String(index + 1)} provider requests, saw ${String(capturedRequests.length)}.`,
    );
  }
  return captured;
};
const outputCeilingAt = (index: number): number => {
  const { maxOutputTokens } = requestAt(index);
  if (maxOutputTokens === undefined) {
    throw new Error("Expected the request to carry an output ceiling.");
  }
  return maxOutputTokens;
};
const buildTestAiFieldGenerator = (
  options: Omit<Parameters<typeof buildAiFieldGenerator>[0], "admission">,
) =>
  buildAiFieldGenerator({
    admission: testModelAdmission(organizationId),
    resolveTextModel,
    ...options,
  });
const buildTestAiOccurrenceAdapter = (
  options: Omit<Parameters<typeof buildAiOccurrenceAdapter>[0], "admission">,
) =>
  buildAiOccurrenceAdapter({
    admission: testModelAdmission(organizationId),
    resolveTextModel,
    ...options,
  });

describe("buildAiFieldGenerator admitted action", () => {
  test("a generation in flight stops when its admitted action's lease is lost", async () => {
    const lease = new AbortController();
    const reached = Promise.withResolvers<AbortSignal>();
    const model = blockingModel(reached);
    const generation = admitModelDispatch({
      organizationId,
      actionKind: "report-export.background",
      signal: lease.signal,
      run: async (admission) =>
        await buildAiFieldGenerator({
          admission,
          resolveTextModel: async () => model,
          orgAIConfig,
          managedAIResidency: "eu" as const,
          organizationId,
          tenantWorkspaceIds: [],
        })?.({ prompt: PLAIN_PROMPT, fieldPath: "scope", values: {} }),
    });

    const providerSignal = await reached.promise;
    expect(providerSignal.aborted).toBe(false);
    lease.abort();

    expect(await generation).toMatchObject({ type: "failed" });
    expect(providerSignal.aborted).toBe(true);
  });
});

describe("buildAiFieldGenerator skill-tool wiring", () => {
  test("does not advertise skill tools for a ref to no available skill", async () => {
    const generate = buildTestAiFieldGenerator({
      orgAIConfig,
      managedAIResidency: "eu" as const,
      organizationId,
      skillContext,
      tenantWorkspaceIds: [],
    });
    expect(generate).toBeDefined();
    await generate?.({
      prompt: SKILL_REF_PROMPT,
      fieldPath: "scope",
      values: {},
    });

    // The engine always hands the adapter a tool array; empty is what "no
    // skill tools were wired" looks like at the provider boundary.
    expect(lastRequest().toolNames).toEqual([]);
  });

  // A one-shot generator offers no tool besides the skill reads, so a
  // built-in is wired only when it requires no other tool.
  test.each(listSkillMetadata().map((skill) => [skill.name, skill] as const))(
    "wires skill tools for a ref to the built-in %s only when it needs no other tool",
    async (_name, builtIn) => {
      const generate = buildTestAiFieldGenerator({
        orgAIConfig,
        managedAIResidency: "eu" as const,
        organizationId,
        skillContext,
        tenantWorkspaceIds: [],
      });
      await generate?.({
        prompt: `Draft this clause [${builtIn.name}](#stella-skill-ref=${builtIn.name}).`,
        fieldPath: "scope",
        values: {},
      });

      expect(lastRequest().toolNames).toEqual(
        readSkillRequiredTools(builtIn.metadata).length === 0
          ? ["load-skill", "read-skill-resource"]
          : [],
      );
    },
  );

  test("passes no tools when the prompt has no skill reference", async () => {
    const generate = buildTestAiFieldGenerator({
      orgAIConfig,
      managedAIResidency: "eu" as const,
      organizationId,
      skillContext,
      tenantWorkspaceIds: [],
    });
    await generate?.({ prompt: PLAIN_PROMPT, fieldPath: "scope", values: {} });

    expect(lastRequest().toolNames).toEqual([]);
  });

  test("passes no tools without a skill context, even with a ref", async () => {
    const generate = buildTestAiFieldGenerator({
      orgAIConfig,
      managedAIResidency: "eu" as const,
      organizationId,
      tenantWorkspaceIds: [],
    });
    await generate?.({
      prompt: SKILL_REF_PROMPT,
      fieldPath: "scope",
      values: {},
    });

    expect(lastRequest().toolNames).toEqual([]);
  });
});

describe("buildAiFieldGenerator document-text injection", () => {
  test("injects a Document section when documentText is supplied", async () => {
    const generate = buildTestAiFieldGenerator({
      orgAIConfig,
      managedAIResidency: "eu" as const,
      organizationId,
      tenantWorkspaceIds: [],
    });
    await generate?.({
      prompt: PLAIN_PROMPT,
      fieldPath: "scope",
      values: {},
      documentText: "THE FULL CONTRACT BODY",
    });

    expect(lastRequest().prompt ?? "").toContain(
      "Document:\nTHE FULL CONTRACT BODY",
    );
  });

  test("omits the Document section when no documentText is supplied", async () => {
    const generate = buildTestAiFieldGenerator({
      orgAIConfig,
      managedAIResidency: "eu" as const,
      organizationId,
      tenantWorkspaceIds: [],
    });
    await generate?.({ prompt: PLAIN_PROMPT, fieldPath: "scope", values: {} });

    expect(lastRequest().prompt ?? "").not.toContain("Document:");
  });

  test("omits the Document section for blank documentText", async () => {
    const generate = buildTestAiFieldGenerator({
      orgAIConfig,
      managedAIResidency: "eu" as const,
      organizationId,
      tenantWorkspaceIds: [],
    });
    await generate?.({
      prompt: PLAIN_PROMPT,
      fieldPath: "scope",
      values: {},
      documentText: "   ",
    });

    expect(lastRequest().prompt ?? "").not.toContain("Document:");
  });
});

describe("buildAiOccurrenceAdapter skill-tool wiring", () => {
  const occurrences = [{ context: "see {{scope}} herein" }];

  test("does not advertise skill tools for a ref to no available skill", async () => {
    const adapt = buildTestAiOccurrenceAdapter({
      orgAIConfig,
      managedAIResidency: "eu" as const,
      organizationId,
      skillContext,
      tenantWorkspaceIds: [],
    });
    expect(adapt).toBeDefined();
    await adapt?.({
      stub: "the scope",
      fieldPath: "scope",
      label: "Scope",
      prompt: SKILL_REF_PROMPT,
      occurrences,
    });

    expect(lastRequest().toolNames).toEqual([]);
  });

  test("passes no tools when the instruction has no skill reference", async () => {
    const adapt = buildTestAiOccurrenceAdapter({
      orgAIConfig,
      managedAIResidency: "eu" as const,
      organizationId,
      skillContext,
      tenantWorkspaceIds: [],
    });
    await adapt?.({
      stub: "the scope",
      fieldPath: "scope",
      label: "Scope",
      prompt: PLAIN_PROMPT,
      occurrences,
    });

    expect(lastRequest().toolNames).toEqual([]);
  });
});

describe("buildAiFieldGenerator truncated output", () => {
  const draftField = async (
    resolveModel: typeof resolveTextModel,
    maxLength?: number,
  ) => {
    const generate = buildTestAiFieldGenerator({
      orgAIConfig,
      managedAIResidency: "eu" as const,
      organizationId,
      resolveTextModel: resolveModel,
      tenantWorkspaceIds: [],
    });
    return await generate?.({
      prompt: PLAIN_PROMPT,
      fieldPath: "scope",
      values: {},
      ...(maxLength === undefined ? {} : { maxLength }),
    });
  };

  test("reports a value cut at the output ceiling instead of writing it", async () => {
    const draft = await draftField(
      resolveScriptedModel([{ finishReason: "length", text: CUT_VALUE }]),
    );

    expect(draft).toEqual({
      type: "failed",
      reason: "truncated",
      message:
        "The model reached its output limit before finishing this field.",
    });
    // The cut text reached this process; what must never happen is it reaching
    // the document as the field's value.
    expect(JSON.stringify(draft)).not.toContain(CUT_VALUE);
  });

  test("retries once at a wider ceiling before reporting the cut", async () => {
    await draftField(
      resolveScriptedModel([{ finishReason: "length", text: CUT_VALUE }]),
    );

    expect(capturedRequests).toHaveLength(2);
    expect(outputCeilingAt(1)).toBeGreaterThan(outputCeilingAt(0));
  });

  test("keeps the retry's complete value", async () => {
    const draft = await draftField(
      resolveScriptedModel([
        { finishReason: "length", text: CUT_VALUE },
        { finishReason: "stop", text: DRAFTED_VALUE },
      ]),
    );

    expect(draft).toEqual({ type: "drafted", value: DRAFTED_VALUE });
  });

  test("does not retry a run that finished on its own", async () => {
    const draft = await draftField(resolveScriptedModel(COMPLETE_RUN));

    expect(draft).toEqual({ type: "drafted", value: DRAFTED_VALUE });
    expect(capturedRequests).toHaveLength(1);
  });

  test("provider exceptions cannot disclose request content in field diagnostics", async () => {
    const draft = await draftField(() => {
      throw new Error("Provider echoed confidential document contents");
    });
    expect(draft).toEqual({
      type: "failed",
      reason: "generation-failed",
      message:
        "AI field generation failed. Retry or provide the value yourself.",
    });
  });
});

describe("output budgets are sized from the work asked for", () => {
  test("a field's ceiling covers its declared maximum value length", async () => {
    const generate = buildTestAiFieldGenerator({
      orgAIConfig,
      managedAIResidency: "eu" as const,
      organizationId,
      tenantWorkspaceIds: [],
    });

    await generate?.({
      prompt: PLAIN_PROMPT,
      fieldPath: "scope",
      values: {},
      maxLength: 200,
    });
    const shortField = outputCeilingAt(0);

    await generate?.({
      prompt: PLAIN_PROMPT,
      fieldPath: "scope",
      values: {},
      maxLength: 4000,
    });
    const longField = outputCeilingAt(1);

    expect(longField).toBeGreaterThan(shortField);
    // One token per character is the pessimistic tokenizer assumption that
    // keeps an inflected-language value inside the ceiling.
    expect(shortField).toBeGreaterThanOrEqual(200);
    expect(longField).toBeGreaterThanOrEqual(4000);
  });

  test("an adaptation's ceiling scales with the number of occurrences", async () => {
    const adapt = buildTestAiOccurrenceAdapter({
      orgAIConfig,
      managedAIResidency: "eu" as const,
      organizationId,
      tenantWorkspaceIds: [],
    });
    const adaptOccurrences = async (count: number) => {
      await adapt?.({
        stub: "czech law",
        fieldPath: "governing_law",
        label: "Governing law",
        prompt: PLAIN_PROMPT,
        occurrences: Array.from({ length: count }, () => ({
          context: "governed by {{governing_law}}",
        })),
      });
      return outputCeilingAt(-1);
    };

    const one = await adaptOccurrences(1);
    const eight = await adaptOccurrences(8);

    expect(eight).toBeGreaterThan(one);
  });
});

describe("buildAiConditionDecider decision tier", () => {
  /** A decision model over a fake wire answering the condition with one noul. */
  const decisionModel = (yes: number): DecisionModel => {
    const fetcher: Fetcher = async () =>
      await Promise.resolve(
        new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: { answer: { type: "noul", noul: yes } },
            usage: { input_tokens: 40, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    return {
      ...createSystemOneClient({ apiKey: "key-test", fetcher }),
      keySource: "byok",
    };
  };
  const input = {
    prompt: "Is the principal a company?",
    fieldPath: "principalIsCompany",
    values: { principalName: "Acme s.r.o." },
  };

  test("a decided answer settles the condition without reaching the generative provider", async () => {
    const decideCondition = buildAiConditionDecider({
      decisionModel: decisionModel(0.94),
      orgAIConfig,
      managedAIResidency: "eu" as const,
      organizationId,
      admission: testModelAdmission(organizationId),
      resolveTextModel,
      tenantWorkspaceIds: [],
    });

    expect(await decideCondition?.(input)).toEqual({
      decidedBy: "decision_model",
      value: true,
      probability: 0.94,
    });
    expect(capturedRequests).toEqual([]);
  });

  test("a no carries the probability of the no, not of the yes", async () => {
    const decideCondition = buildAiConditionDecider({
      decisionModel: decisionModel(0.04),
      orgAIConfig,
      managedAIResidency: "eu" as const,
      organizationId,
      admission: testModelAdmission(organizationId),
      resolveTextModel,
      tenantWorkspaceIds: [],
    });

    const decided = await decideCondition?.(input);

    expect(decided?.decidedBy).toBe("decision_model");
    expect(decided).toMatchObject({ value: false });
    expect(
      decided?.decidedBy === "decision_model" ? decided.probability : null,
    ).toBeCloseTo(0.96, 6);
  });

  test("an answer under the floor hands the condition to the generative model", async () => {
    const decideCondition = buildAiConditionDecider({
      decisionModel: decisionModel(0.55),
      orgAIConfig,
      managedAIResidency: "eu" as const,
      organizationId,
      admission: testModelAdmission(organizationId),
      resolveTextModel,
      tenantWorkspaceIds: [],
    });

    const decided = await decideCondition?.(input);

    expect(lastRequest().prompt).toContain("Is the principal a company?");
    // The generative tier answers without a probability: there is none to give.
    expect(decided).toEqual({ decidedBy: "generative_model", value: true });
  });

  test("with no decision model the generative model answers, as before", async () => {
    const decideCondition = buildAiConditionDecider({
      decisionModel: null,
      orgAIConfig,
      managedAIResidency: "eu" as const,
      organizationId,
      admission: testModelAdmission(organizationId),
      resolveTextModel,
      tenantWorkspaceIds: [],
    });

    const decided = await decideCondition?.(input);

    expect(capturedRequests).toHaveLength(1);
    expect(decided?.decidedBy).toBe("generative_model");
  });

  test("keeps conditions unavailable without an eligible customer-content model", () => {
    const previousMock = env.USE_MOCK_AI;
    const previousApiKey = env.TYPESAFE_API_KEY;
    const previousRequirePersonalKey = env.REQUIRE_PERSONAL_AI_KEY;
    const previousProvider = env.AI_PROVIDER;
    const previousAnthropicKey = env.ANTHROPIC_API_KEY;
    env.USE_MOCK_AI = false;
    env.TYPESAFE_API_KEY = "key-test";
    env.REQUIRE_PERSONAL_AI_KEY = false;
    env.AI_PROVIDER = "anthropic";
    env.ANTHROPIC_API_KEY = "key-test";
    try {
      const customerDecisionModel = resolveDecisionModel(null, "customer");
      expect(customerDecisionModel).toBeNull();
      const decideCondition = buildAiConditionDecider({
        decisionModel: customerDecisionModel,
        orgAIConfig: null,
        managedAIResidency: "eu",
        organizationId,
        admission: testModelAdmission(organizationId),
        resolveTextModel,
        tenantWorkspaceIds: [],
      });
      expect(decideCondition).toBeUndefined();
      expect(capturedRequests).toEqual([]);
    } finally {
      env.USE_MOCK_AI = previousMock;
      env.TYPESAFE_API_KEY = previousApiKey;
      env.REQUIRE_PERSONAL_AI_KEY = previousRequirePersonalKey;
      env.AI_PROVIDER = previousProvider;
      env.ANTHROPIC_API_KEY = previousAnthropicKey;
    }
  });
});
