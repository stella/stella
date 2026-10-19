import { panic, Result } from "better-result";
import { afterAll, describe, expect, spyOn, test } from "bun:test";

import { BYOK_DEFAULT_MODELS } from "@stll/ai-catalog";

import { env } from "@/api/env";
import { compactChatMessagesForModel } from "@/api/handlers/chat/compaction";
import type { ChatMessage } from "@/api/handlers/chat/types";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { toSafeId } from "@/api/lib/branded-types";
import { HISTORY_TRIMMED_NOTICE } from "@/api/lib/chat/context-notice";
import {
  ModelOutputIncompleteError,
  ModelOutputModeratedError,
  ModelRunError,
} from "@/api/lib/errors/provider-call-error";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";
import { generateTanStackTextForTask } from "@/api/lib/tanstack-ai-generate";
import type { TanStackTextFinishPolicy } from "@/api/lib/tanstack-ai-generate";
import { MANAGED_MODEL_TIER } from "@/api/lib/usage/managed-model-tier";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// The output ceiling read through the production chain: the real OpenRouter
// adapter (an organization's own key, and the deployment's managed key),
// the provider stream contract and the text generation that grades the
// finish. Only `fetch` is scripted; no request leaves the process.

const organizationId = toSafeId<"organization">("org_output_ceiling");
const MODEL = BYOK_DEFAULT_MODELS.openrouter.chat.modelId;
const OPENROUTER_HOSTS = new Set([
  "openrouter.ai",
  "eu.openrouter.ai",
  "us.openrouter.ai",
]);

const byokConfig: OrgAIConfig = {
  providers: [{ provider: "openrouter", apiKey: "fixture-org-key" }],
  overrideModels: {
    chat: { provider: "openrouter", modelId: MODEL },
    fast: { provider: "openrouter", modelId: MODEL },
    pdf: { provider: "openrouter", modelId: MODEL },
    reasoning: { provider: "openrouter", modelId: MODEL },
  },
  decision: null,
};

const KEY_SOURCES = {
  byok: { orgAIConfig: byokConfig, host: "openrouter.ai" },
  managed: { orgAIConfig: null, host: "eu.openrouter.ai" },
} as const;

type RequestBody = {
  max_completion_tokens?: number;
  messages: { content: unknown; role: string }[];
  reasoning?: { effort?: string };
};

/** One provider response, given the request it answers. */
type Answer = (body: RequestBody) => {
  chunks: Record<string, unknown>[];
  usage: { completionTokens: number };
};

const sse = (
  chunks: readonly Record<string, unknown>[],
  completionTokens: number,
) => {
  const base = {
    id: "gen-fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: MODEL,
  };
  const events = [
    ...chunks.map((chunk) => ({ ...base, ...chunk })),
    {
      ...base,
      choices: [],
      usage: {
        prompt_tokens: 50_000,
        completion_tokens: completionTokens,
        total_tokens: 50_000 + completionTokens,
      },
    },
  ];
  return new Response(
    [
      ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
      "data: [DONE]\n\n",
    ].join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
};

const delta = (
  values: Record<string, unknown>,
  finishReason: string | null = null,
) => ({
  choices: [
    {
      index: 0,
      delta: { role: "assistant", ...values },
      finish_reason: finishReason,
    },
  ],
});

/** Reasoning that spends the whole output ceiling the request set. */
const reasoningSpendsTheCeiling =
  (finish: string | null): Answer =>
  (body) => ({
    chunks: [
      delta({
        content: "",
        reasoning_details: [
          {
            type: "reasoning.text",
            text: "Weighing the earlier turns",
            index: 0,
          },
        ],
      }),
      delta({ content: "## Done\n- Reviewed the lease" }),
      ...(finish === null ? [] : [delta({ content: "" }, finish)]),
    ],
    usage: {
      completionTokens: body.max_completion_tokens ?? panic("No ceiling sent"),
    },
  });

const answersWith =
  (text: string): Answer =>
  () => ({
    chunks: [delta({ content: text }), delta({ content: "" }, "stop")],
    usage: { completionTokens: 300 },
  });

/** What the scripted provider answers the next request with. */
const script: { answer: Answer } = { answer: answersWith("unused") };
const sent: { host: string; body: RequestBody }[] = [];
const originalFetch = globalThis.fetch;
const testState = createTestState({ file: import.meta.path, config: env });

testState.beforeAll(() => {
  // Real adapters, and a managed key the deployment's factory can use.
  testState.setConfig("USE_MOCK_AI", false);
  testState.setConfig("OPENROUTER_API_KEY", "fixture-managed-key");
  testState.setConfig("FEATURE_MANAGED_PROVIDER_CHECKS", false);
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input.toString(), init);
      const url = new URL(request.url);
      if (!OPENROUTER_HOSTS.has(url.hostname)) {
        return panic(`Refused a request to ${url.hostname}`);
      }
      const body = asTestRaw<RequestBody>(await request.clone().json());
      sent.push({ host: url.hostname, body });
      const { chunks, usage } = script.answer(body);
      return sse(chunks, usage.completionTokens);
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const generate = async (
  keySource: keyof typeof KEY_SOURCES,
  maxOutputTokens: number,
  finishPolicy: TanStackTextFinishPolicy = "require-complete",
) => {
  sent.length = 0;
  const result = await Result.tryPromise(
    async () =>
      await generateTanStackTextForTask({
        admission: testModelAdmission(organizationId),
        caching: { enabled: false, reason: "org-disabled" },
        dataClass: "customer",
        finishPolicy,
        managedAIResidency: "eu",
        maxOutputTokens,
        orgAIConfig: KEY_SOURCES[keySource].orgAIConfig,
        organizationId,
        userId: null,
        prompt: "Summarize the lease negotiation so far.",
        task: "chat",
        serviceTier: "standard",
        tenantWorkspaceIds: [],
      }),
  );
  expect(sent.map(({ host }) => host)).toEqual([KEY_SOURCES[keySource].host]);
  return result;
};

/** How a run failed, as a sink sees it. */
const failureOf = (result: Result<string, { cause: unknown }>) => {
  if (Result.isOk(result)) {
    return panic("Expected the run to fail");
  }
  const error = result.error.cause;
  return {
    name: error instanceof Error ? error.name : String(error),
    finish: error instanceof ModelRunError ? error.finish : undefined,
  };
};

describe("an answer cut at its output ceiling", () => {
  // The provider labels the stop `length`, with a reason no table lists, or
  // ends the stream without a label; the usage it reports shows the ceiling
  // spent.
  const LABELS = ["length", "provider_specific_stop", null] as const;

  for (const label of LABELS) {
    test(`reads as an incomplete answer on both key sources when labelled ${String(label)}`, async () => {
      script.answer = reasoningSpendsTheCeiling(label);
      const failures = [];
      for (const keySource of ["byok", "managed"] as const) {
        const result = await generate(keySource, 64);
        // The ceiling sent is the request's, plus any reasoning reservation.
        expect(sent.at(0)?.body.max_completion_tokens).toBeGreaterThanOrEqual(
          64,
        );
        if (Result.isError(result)) {
          expect(result.error.cause).toBeInstanceOf(ModelOutputIncompleteError);
        }
        failures.push(failureOf(result));
      }
      expect(failures.at(0)).toEqual(failures.at(1));
      expect(failures.at(0)).toMatchObject({
        name: "ModelOutputIncompleteError",
        finish: { finish: "length" },
      });
    });
  }

  test("keeps an explicit provider failure at the ceiling a failure", async () => {
    // A generation the provider says failed is no partial answer, whatever
    // it spent, so even a policy that accepts a ceiling stop rejects it.
    script.answer = reasoningSpendsTheCeiling("error");
    for (const keySource of ["byok", "managed"] as const) {
      const result = await generate(keySource, 64, "allow-output-ceiling");
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.cause).not.toBeInstanceOf(
          ModelOutputIncompleteError,
        );
      }
    }
  });

  test("keeps an explicit moderation at the ceiling a moderated answer", async () => {
    // Spent usage cannot overrule the provider's own word on the content, so
    // a policy that accepts a ceiling stop still rejects this answer.
    script.answer = reasoningSpendsTheCeiling("content_filter");
    for (const finishPolicy of [
      "require-complete",
      "allow-output-ceiling",
    ] as const) {
      const result = await generate("byok", 64, finishPolicy);
      if (Result.isError(result)) {
        expect(result.error.cause).toBeInstanceOf(ModelOutputModeratedError);
      }
      expect(failureOf(result)).toEqual({
        name: "ModelOutputModeratedError",
        finish: {
          finish: "content_filter",
          providerStopReason: "content_filter",
        },
      });
    }
  });

  test("keeps an answer with an unlisted stop under the ceiling", async () => {
    script.answer = () => ({
      chunks: [
        delta({ content: "## Done\n- Reviewed the lease" }),
        delta({ content: "" }, "provider_specific_stop"),
      ],
      usage: { completionTokens: 12 },
    });
    for (const keySource of ["byok", "managed"] as const) {
      const result = await generate(keySource, 64);
      expect(Result.isOk(result) ? result.value : "").toContain(
        "Reviewed the lease",
      );
    }
  });

  test("leaves a filtered answer under the ceiling a moderated one", async () => {
    script.answer = () => ({
      chunks: [delta({ content: "" }, "content_filter")],
      usage: { completionTokens: 3 },
    });
    for (const keySource of ["byok", "managed"] as const) {
      const result = await generate(keySource, 64);
      if (Result.isError(result)) {
        expect(result.error.cause).toBeInstanceOf(ModelOutputModeratedError);
      }
      expect(failureOf(result)).toEqual({
        name: "ModelOutputModeratedError",
        finish: {
          finish: "content_filter",
          providerStopReason: "content_filter",
        },
      });
    }
  });
});

/** A long legal thread: enough turns to cross the default trigger. */
const longThread = (): ChatMessage[] =>
  Array.from({ length: 48 }, (_, turn) => [
    {
      id: toSafeId<"chatMessage">(`msg_user_${turn}`),
      role: "user" as const,
      parts: [
        {
          type: "text" as const,
          content:
            `Turn ${turn}: review clause ${turn + 1} of the commercial lease for the landlord's repair duties and the tenant's break option. `.repeat(
              28,
            ),
        },
      ],
    },
    {
      id: toSafeId<"chatMessage">(`msg_assistant_${turn}`),
      role: "assistant" as const,
      parts: [
        {
          type: "text" as const,
          content:
            `Clause ${turn + 1} puts structural repairs on the landlord and allows a break on six months' notice. `.repeat(
              28,
            ),
        },
      ],
    },
  ]).flat();

const compactThread = async (keySource: keyof typeof KEY_SOURCES) => {
  sent.length = 0;
  const summaryErrors: HandlerError[] = [];
  const result = await compactChatMessagesForModel({
    abortSignal: AbortSignal.timeout(10_000),
    aiAnalytics: createTanStackAIAnalyticsCallbacks({
      analytics: {
        capture: () => undefined,
        flush: async () => undefined,
        identifyOrganizationGroup: () => undefined,
      },
      dataClass: "customer",
      feature: "chat.context_compaction",
      modelTier: MANAGED_MODEL_TIER.standard,
      orgAIConfig: KEY_SOURCES[keySource].orgAIConfig,
      traceId: `trace_${keySource}`,
    }),
    admission: testModelAdmission(organizationId),
    boundary: { type: "raw" },
    managedAIResidency: "eu",
    messages: longThread(),
    onSummaryError: (error) => {
      summaryErrors.push(error);
    },
    orgAIConfig: KEY_SOURCES[keySource].orgAIConfig,
    organizationId,
    tenantWorkspaceIds: [],
  });
  if (Result.isError(result)) {
    return panic("Compaction failed outright");
  }
  return { compacted: result.value, summaryErrors };
};

describe("compacting a long thread", () => {
  test("asks for a summary its ceiling has room for, and checkpoints it", async () => {
    script.answer = answersWith(
      "## Done\n- Reviewed every clause of the lease",
    );
    for (const keySource of ["byok", "managed"] as const) {
      const { compacted, summaryErrors } = await compactThread(keySource);
      expect(summaryErrors).toEqual([]);
      expect(compacted.notice).toBeNull();
      const firstPart = compacted.messages.at(0)?.parts.at(0);
      expect(firstPart?.type === "text" ? firstPart.content : "").toContain(
        "Reviewed every clause of the lease",
      );
      const request = sent.at(0)?.body ?? panic("No summary request");
      const prompt = JSON.stringify(request.messages);
      const words = Number(/under (\d+) words/u.exec(prompt)?.[1]);
      expect(words).toBeGreaterThan(0);
      // The ceiling leaves the target room twice over, and more besides.
      expect(request.max_completion_tokens).toBeGreaterThan(
        2 * Math.ceil(words / 0.75),
      );
    }
  });

  test("does not checkpoint an answered summary whose unlisted stop spent the ceiling", async () => {
    script.answer = reasoningSpendsTheCeiling("provider_specific_stop");
    for (const keySource of ["byok", "managed"] as const) {
      const { compacted, summaryErrors } = await compactThread(keySource);
      expect(summaryErrors).toHaveLength(1);
      expect(summaryErrors.at(0)?.cause).toBeInstanceOf(
        ModelOutputIncompleteError,
      );
      expect(compacted.notice).toEqual(HISTORY_TRIMMED_NOTICE);
      expect(JSON.stringify(compacted.messages)).not.toContain(
        "Reviewed the lease",
      );
    }
  });

  test("keeps the newest history and says so when the summary hits its ceiling", async () => {
    script.answer = reasoningSpendsTheCeiling(null);
    const outcomes = [];
    for (const keySource of ["byok", "managed"] as const) {
      const errorSpy = spyOn(logger, "error");
      const warnSpy = spyOn(logger, "warn");
      const { compacted, summaryErrors } = await compactThread(keySource);
      const failures = (spy: typeof warnSpy) =>
        spy.mock.calls.filter(
          ([event]) => event === "tanstack_ai.generation.failed",
        );
      // An incomplete answer, named with how it ended: never a defect.
      expect(failures(errorSpy)).toEqual([]);
      expect(failures(warnSpy)).toEqual([
        [
          "tanstack_ai.generation.failed",
          expect.objectContaining({
            "ai.error_kind": "output_incomplete",
            "ai.finish_reason": "length",
          }),
        ],
      ]);
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      const thread = longThread();
      expect(compacted.notice).toEqual(HISTORY_TRIMMED_NOTICE);
      const kept = compacted.messages.map(({ id }) => id);
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.length).toBeLessThan(thread.length);
      expect(kept).toEqual(
        thread.slice(thread.length - kept.length).map(({ id }) => id),
      );
      expect(summaryErrors).toHaveLength(1);
      const cause = summaryErrors.at(0)?.cause;
      expect(cause).toBeInstanceOf(ModelOutputIncompleteError);
      outcomes.push({ kept, cause: cause instanceof Error ? cause.name : "" });
    }
    expect(outcomes.at(0)).toEqual(outcomes.at(1));
  });
});
