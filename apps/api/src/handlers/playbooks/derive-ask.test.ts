import { describe, expect, mock, test } from "bun:test";
import type {
  Response as OpenAIResponse,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import * as v from "valibot";

import { resolveDefaultModel } from "@stll/ai-catalog";
import { createTestState } from "@stll/test-state";

import { env } from "@/api/env";
import {
  computeRulesHash,
  DERIVE_CLAUSE_ASK_SYSTEM_PROMPT,
  DERIVE_CONSTRAINT_ASK_SYSTEM_PROMPT,
  deriveAutoAsks,
} from "@/api/handlers/playbooks/derive-ask";
import type {
  DeriveAskGenerate,
  DeriveClauseAskResult,
} from "@/api/handlers/playbooks/derive-ask";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import { clearByokAdapterCache } from "@/api/lib/tanstack-ai-models";
import type { PlaybookPositions } from "@/api/lib/workflow/playbook-positions";
import type { TierStandardPosition } from "@/api/lib/workflow/position-runtime";
import { testModelActionAdmitter } from "@/api/tests/helpers/model-dispatch-admission";
import { effectiveRequest } from "@/api/tests/helpers/provider-wire-replay";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";

const testFetchState = createTestFetch();

const testState = createTestState({ file: import.meta.path, config: env });

const textContent = { version: 1, type: "text" } as const;

const graded = (
  overrides: Partial<TierStandardPosition> = {},
): TierStandardPosition => ({
  mode: "graded",
  sourceId: "11111111-1111-4111-8111-111111111111",
  issue: "Governing law",
  severity: "high",
  ask: { mode: "auto" },
  standard: {
    source: "tiers",
    tiers: {
      acceptable: {
        rules: [{ id: "ar-1", text: "A common-law jurisdiction." }],
      },
      fallback: { entries: [] },
      notAcceptable: { rules: [] },
    },
  },
  enabled: true,
  ...overrides,
});

const container = (position: TierStandardPosition): PlaybookPositions => ({
  version: 3,
  items: [position],
});

const presenceCheck = {
  kind: "presence",
  expectation: "required",
} as const satisfies TierStandardPosition["check"];

const constraintCheck = {
  kind: "constraint",
  condition: {
    type: "group",
    combinator: "and",
    children: [
      {
        type: "compare",
        left: {
          type: "property",
          propertyId: "11111111-1111-4111-8111-111111111111",
        },
        op: "lte",
        right: { type: "literal", value: 30 },
      },
    ],
  },
} as const satisfies TierStandardPosition["check"];

const unexpectedCall = async (): Promise<never> =>
  await Promise.reject(new Error("generator must not be called"));

const answeringClause = (question: string): DeriveAskGenerate => ({
  clause: async () => ({ question }),
  constraint: unexpectedCall,
});

const storedAsk = (result: PlaybookPositions) => {
  const [item] = result.items;
  return item?.mode === "graded" ? item.ask : null;
};

const deps = {
  admitModelAction: testModelActionAdmitter(toSafeId<"organization">("org_1")),
  organizationId: toSafeId<"organization">("org_1"),
  orgAIConfig: null,
  orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
  managedAIResidency: "eu" as const,
  promptCachingEnabled: false,
};

describe("computeRulesHash — stability", () => {
  test("same grading inputs produce the same hash", () => {
    expect(computeRulesHash(graded())).toBe(computeRulesHash(graded()));
  });

  test("changing a rule text produces a new hash", () => {
    const changed = graded({
      standard: {
        source: "tiers",
        tiers: {
          acceptable: {
            rules: [{ id: "ar-1", text: "A civil-law jurisdiction." }],
          },
          fallback: { entries: [] },
          notAcceptable: { rules: [] },
        },
      },
    });
    expect(computeRulesHash(changed)).not.toBe(computeRulesHash(graded()));
  });

  test("adding a deterministic check produces a new hash", () => {
    const withCheck = graded({
      check: { kind: "presence", expectation: "required" },
    });
    expect(computeRulesHash(withCheck)).not.toBe(computeRulesHash(graded()));
  });
});

describe("deriveAutoAsks — the check decides the shape", () => {
  test.each([
    ["no check", undefined],
    ["a presence check", presenceCheck],
  ])("%s stores a text ask from the clause prompt", async (_label, check) => {
    const systems: string[] = [];
    const position = graded(check === undefined ? {} : { check });

    const result = await deriveAutoAsks(container(position), {
      ...deps,
      generate: {
        clause: async ({ system }) => {
          systems.push(system);
          return { question: "What does the contract say about the law?" };
        },
        constraint: unexpectedCall,
      },
    });

    expect(systems).toEqual([DERIVE_CLAUSE_ASK_SYSTEM_PROMPT]);
    expect(storedAsk(result)).toEqual({
      mode: "auto",
      derived: {
        question: "What does the contract say about the law?",
        content: textContent,
        rulesHash: computeRulesHash(position),
      },
    });
  });

  test.each(["int", "date", "text"] as const)(
    "a constraint check stores the %s type the generator chose, from the constraint prompt",
    async (contentType) => {
      const systems: string[] = [];
      const position = graded({ check: constraintCheck });

      const result = await deriveAutoAsks(container(position), {
        ...deps,
        generate: {
          clause: unexpectedCall,
          constraint: async ({ system }) => {
            systems.push(system);
            return { question: "How many days?", contentType };
          },
        },
      });

      expect(systems).toEqual([DERIVE_CONSTRAINT_ASK_SYSTEM_PROMPT]);
      expect(storedAsk(result)).toEqual({
        mode: "auto",
        derived: {
          question: "How many days?",
          content: { version: 1, type: contentType },
          rulesHash: computeRulesHash(position),
        },
      });
    },
  );

  test("the two prompts differ, and only the clause prompt forbids a single value", () => {
    expect(DERIVE_CLAUSE_ASK_SYSTEM_PROMPT).toContain(
      "every term the rules cover",
    );
    expect(DERIVE_CLAUSE_ASK_SYSTEM_PROMPT).not.toContain("contentType");
    expect(DERIVE_CONSTRAINT_ASK_SYSTEM_PROMPT).toContain("contentType");
  });

  test("a stored ask is replaced only when a grading input changes", async () => {
    const position = graded();
    const narrow = graded({
      ask: {
        mode: "auto",
        derived: {
          question: "How many days of notice?",
          content: { version: 1, type: "int" },
          rulesHash: computeRulesHash(position),
        },
      },
    });

    const unchanged = await deriveAutoAsks(container(narrow), {
      ...deps,
      generate: { clause: unexpectedCall, constraint: unexpectedCall },
    });
    expect(storedAsk(unchanged)).toEqual(narrow.ask);

    const edited = { ...narrow, issue: "Governing law and forum" };
    const rederived = await deriveAutoAsks(container(edited), {
      ...deps,
      generate: answeringClause("What does the contract say?"),
    });
    expect(storedAsk(rederived)).toEqual({
      mode: "auto",
      derived: {
        question: "What does the contract say?",
        content: textContent,
        rulesHash: computeRulesHash(edited),
      },
    });
  });
});

describe("deriveAutoAsks — save resilience", () => {
  test("the default generator resolves the PDF override and saves the provider's derived ask", async () => {
    testState.setConfig("USE_MOCK_AI", false);
    const pdfModelId = "gpt-5.4";
    expect(pdfModelId).not.toBe(
      resolveDefaultModel({ task: "pdf", orgProviders: ["openai"] })?.modelId,
    );
    const orgAIConfig = {
      providers: [{ provider: "openai", apiKey: "derive-ask-fixture-key" }],
      overrideModels: {
        pdf: { provider: "openai", modelId: pdfModelId },
      },
      decision: null,
    } satisfies OrgAIConfig;
    const generatedAsk = {
      question: "What law governs the agreement?",
    } satisfies DeriveClauseAskResult;
    const providerResponse = {
      id: "derive-ask-response",
      created_at: 0,
      output_text: JSON.stringify(generatedAsk),
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      model: pdfModelId,
      object: "response",
      parallel_tool_calls: false,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
      status: "completed",
      output: [
        {
          id: "derive-ask-message",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: JSON.stringify(generatedAsk),
              annotations: [],
            },
          ],
        },
      ],
      usage: {
        input_tokens: 20,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 10,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 30,
      },
    } satisfies OpenAIResponse;
    // The awaited TanStack object call still uses the adapter's native stream.
    const providerEvents = [
      {
        type: "response.output_text.delta",
        content_index: 0,
        item_id: "derive-ask-message",
        logprobs: [],
        output_index: 0,
        sequence_number: 0,
        delta: JSON.stringify(generatedAsk),
      },
      {
        type: "response.completed",
        sequence_number: 1,
        response: providerResponse,
      },
    ] satisfies ResponseStreamEvent[];
    const requests: { model: string; outputProperties: string[] }[] = [];
    const analytics = installRecordingAnalytics();
    const logs = installRecordingLogger();
    const fetchSpy = Object.assign(
      mock(
        Object.assign(
          async (
            input: Parameters<typeof globalThis.fetch>[0],
            init?: RequestInit,
          ) => {
            const request = effectiveRequest(input, init);
            expect(new URL(request.url).pathname).toBe("/v1/responses");
            const body = v.parse(
              v.object({
                model: v.string(),
                stream: v.literal(true),
                text: v.object({
                  format: v.object({
                    schema: v.object({
                      properties: v.record(v.string(), v.unknown()),
                    }),
                  }),
                }),
              }),
              await request.json(),
            );
            requests.push({
              model: body.model,
              outputProperties: Object.keys(body.text.format.schema.properties),
            });
            return new Response(
              providerEvents
                .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                .join(""),
              {
                headers: { "content-type": "text/event-stream" },
              },
            );
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      ),
      { preconnect: globalThis.fetch.preconnect },
    );
    testFetchState.set(fetchSpy);
    clearByokAdapterCache();
    try {
      const position = graded();
      const result = await deriveAutoAsks(container(position), {
        ...deps,
        orgAIConfig,
      });

      expect(requests).toEqual([
        { model: pdfModelId, outputProperties: ["question"] },
      ]);
      expect(analytics.exceptions()).toEqual([]);
      expect(result.items.at(0)).toEqual({
        ...position,
        ask: {
          mode: "auto",
          derived: {
            question: generatedAsk.question,
            content: textContent,
            rulesHash: computeRulesHash(position),
          },
        },
      });
    } finally {
      testFetchState.restore();
      clearByokAdapterCache();
      logs.restore();
      analytics.restore();
    }
  });

  test("a successful derivation stores the derived ask with its rulesHash", async () => {
    const generate = answeringClause("What law governs the agreement?");

    const position = graded();
    const result = await deriveAutoAsks(container(position), {
      ...deps,
      generate,
    });

    const [item] = result.items;
    expect(item?.mode).toBe("graded");
    if (item?.mode === "graded" && item.ask.mode === "auto") {
      expect(item.ask.derived).toEqual({
        question: "What law governs the agreement?",
        content: { version: 1, type: "text" },
        rulesHash: computeRulesHash(position),
      });
    }
  });

  test.each([
    ORG_AI_CONFIG_STATUS.unreadable,
    ORG_AI_CONFIG_STATUS.ownKeyRequired,
  ])(
    "an unusable AI config (%s) makes no model call and still saves, dropping a stale `derived`",
    async (orgAIConfigStatus) => {
      let calls = 0;
      const generate: DeriveAskGenerate = {
        clause: async () => {
          calls += 1;
          return { question: "Derived on the wrong key" };
        },
        constraint: unexpectedCall,
      };
      const stale = graded();
      stale.ask = {
        mode: "auto",
        derived: {
          question: "A question derived from older rules",
          content: { version: 1, type: "text" },
          rulesHash: "stale",
        },
      };

      const result = await deriveAutoAsks(container(stale), {
        ...deps,
        orgAIConfigStatus,
        generate,
      });

      expect(calls).toBe(0);
      const [item] = result.items;
      expect(item?.mode === "graded" ? item.ask : null).toEqual({
        mode: "auto",
      });
    },
  );

  test("a thrown derivation still saves, with `derived` absent", async () => {
    const generate: DeriveAskGenerate = {
      clause: async () => {
        throw new Error("model unavailable");
      },
      constraint: unexpectedCall,
    };

    const result = await deriveAutoAsks(container(graded()), {
      ...deps,
      generate,
    });

    const [item] = result.items;
    if (item?.mode === "graded" && item.ask.mode === "auto") {
      expect(item.ask.derived).toBeUndefined();
    } else {
      throw new Error("expected a graded auto position");
    }
  });

  test("an unchanged rulesHash reuses the stored derived (no LLM call)", async () => {
    const position = graded();
    const hash = computeRulesHash(position);
    const withDerived = graded({
      ask: {
        mode: "auto",
        derived: {
          question: "Existing question?",
          content: textContent,
          rulesHash: hash,
        },
      },
    });

    let called = false;
    const generate: DeriveAskGenerate = {
      clause: async () => {
        called = true;
        return { question: "New?" };
      },
      constraint: unexpectedCall,
    };

    const result = await deriveAutoAsks(container(withDerived), {
      ...deps,
      generate,
    });

    expect(called).toBe(false);
    const [item] = result.items;
    if (item?.mode === "graded" && item.ask.mode === "auto") {
      expect(item.ask.derived?.question).toBe("Existing question?");
    }
  });

  test("manual asks and extract positions pass through untouched", async () => {
    let called = false;
    const generate: DeriveAskGenerate = {
      clause: async () => {
        called = true;
        return { question: "x" };
      },
      constraint: unexpectedCall,
    };

    const manual = graded({
      ask: { mode: "manual", question: "Manual?", content: textContent },
    });
    const result = await deriveAutoAsks(container(manual), {
      ...deps,
      generate,
    });

    expect(called).toBe(false);
    expect(result).toEqual(container(manual));
  });
});
