import { Result } from "better-result";
import { beforeEach, describe, expect, test } from "bun:test";

import type { Fetcher } from "@stll/fetch";
import { rejectionOf } from "@stll/property-testing/rejection";

import type { SafeDb } from "@/api/db/safe-db";
import { toSafeId } from "@/api/lib/branded-types";
import type { FieldMeta } from "@/api/lib/docx/types";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import type { DecisionModel } from "@/api/lib/workflow/decisions/decision-model";
import {
  createSystemOneClient,
  SystemOneError,
} from "@/api/lib/workflow/decisions/system-one";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import {
  decideTemplateConditions,
  templateAiConditions,
  templateDecideConditionsLogic,
} from "./template-decide-conditions";

/**
 * The fill form asks this while the person is still typing, so what it shows
 * has to be what the fill will decide: the same fields, the same question, the
 * same values the model is allowed to see. The suite pins that wire, and the
 * mapping of each answer — including the three ways a condition stays
 * undecided, which the form renders as "not decided" rather than a false.
 */

const CONSUMER_PROMPT = "Is this a consumer contract?";
const ARBITRATION_PROMPT = "Does the agreement carry an arbitration clause?";

const fields: FieldMeta[] = [
  {
    path: "is_consumer",
    label: "Consumer contract",
    inputType: "boolean",
    aiPrompt: CONSUMER_PROMPT,
  },
  {
    path: "has_arbitration",
    inputType: "boolean",
    aiPrompt: ARBITRATION_PROMPT,
  },
  // Decided by the person, not the model.
  { path: "is_signed", label: "Signed", inputType: "boolean" },
  { path: "is_draft", inputType: "boolean", aiPrompt: "" },
  // AI-drafted text, not a condition.
  { path: "scope", inputType: "text", aiPrompt: "Draft the scope." },
  // Resolved from the matter at fill time; never shown to the model.
  {
    path: "client_iban",
    inputType: "text",
    source: { kind: "contact", field: "iban" },
  },
];

const values = { party_name: "Acme s.r.o.", client_iban: "CZ0000" };

/** The request bodies the fake wire received, newest last. */
let sent: unknown[] = [];

const answering = (nouls: Record<string, number>): DecisionModel => {
  const fetcher: Fetcher = async (_input, init) => {
    const body = init?.body;
    if (typeof body !== "string") {
      throw new TypeError("the transport posts a JSON string body");
    }
    const request: unknown = JSON.parse(body);
    sent.push(request);
    return await Promise.resolve(
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: Object.fromEntries(
            Object.entries(nouls).map(([id, noul]) => [
              id,
              { type: "noul", noul },
            ]),
          ),
          usage: { input_tokens: 40, output_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };
  return {
    ...createSystemOneClient({ apiKey: "key-test", fetcher }),
    keySource: "byok",
  };
};

const refusing = (status: number): DecisionModel => {
  const fetcher: Fetcher = async () =>
    await Promise.resolve(new Response("nope", { status }));
  return {
    ...createSystemOneClient({ apiKey: "key-test", fetcher }),
    keySource: "byok",
  };
};

const decide = async (client: DecisionModel | null) =>
  await decideTemplateConditions({
    fields,
    values,
    orgAIConfig: null,
    generator: async () => {
      throw new Error("Generation unavailable in this test");
    },
    client,
  });

beforeEach(() => {
  sent = [];
});

describe("templateAiConditions", () => {
  test("selects the boolean fields the model decides, and nothing else", () => {
    expect(templateAiConditions(fields)).toEqual([
      {
        path: "is_consumer",
        label: "Consumer contract",
        prompt: CONSUMER_PROMPT,
      },
      {
        // An unlabelled field is shown by its path, as the fill form shows it.
        path: "has_arbitration",
        label: "has_arbitration",
        prompt: ARBITRATION_PROMPT,
      },
    ]);
  });
});

describe("decideTemplateConditions request", () => {
  test("asks every condition in one call, over the values once", async () => {
    await decide(answering({ is_consumer: 0.9, has_arbitration: 0.1 }));

    expect(sent).toEqual([
      {
        model: "jev-latest",
        // Source-bound values stay out: the fill hides them from the model,
        // so the preview asks about the same details the fill will.
        state: { details: JSON.stringify({ party_name: "Acme s.r.o." }) },
        questions: {
          is_consumer: {
            type: "noul",
            instructions: {
              task: "Is the condition in `condition` true for the document described by `details`?",
              condition: CONSUMER_PROMPT,
            },
            criteria: {
              true: "The details state the condition or entail it.",
              false:
                "The details state that it does not hold, or do not settle it: an unsettled condition excludes its block.",
            },
          },
          has_arbitration: {
            type: "noul",
            instructions: {
              task: "Is the condition in `condition` true for the document described by `details`?",
              condition: ARBITRATION_PROMPT,
            },
            criteria: {
              true: "The details state the condition or entail it.",
              false:
                "The details state that it does not hold, or do not settle it: an unsettled condition excludes its block.",
            },
          },
        },
      },
    ]);
  });

  test("a template with no AI-decided condition reaches no model", async () => {
    const decided = await decideTemplateConditions({
      fields: [{ path: "is_signed", inputType: "boolean" }],
      values,
      orgAIConfig: null,
      generator: async () => {
        throw new Error("Generation unavailable in this test");
      },
      client: answering({}),
    });

    expect(decided).toEqual({ conditions: [], model: null });
    expect(sent).toEqual([]);
  });
});

describe("decideTemplateConditions answers", () => {
  test("reports the chosen side's own probability", async () => {
    const decided = await decide(
      answering({ is_consumer: 0.94, has_arbitration: 0.04 }),
    );

    expect(decided.model).toBe("jev-1.13.0");
    expect(decided.conditions).toEqual([
      {
        path: "is_consumer",
        label: "Consumer contract",
        decision: {
          state: "decided",
          decidedBy: "decision_model",
          value: true,
          probability: 0.94,
          // How far the answer sits from even.
          confidence: expect.closeTo(0.88, 6),
        },
      },
      {
        path: "has_arbitration",
        label: "has_arbitration",
        decision: {
          state: "decided",
          decidedBy: "decision_model",
          value: false,
          // The no, not the yes.
          probability: expect.closeTo(0.96, 6),
          confidence: expect.closeTo(0.92, 6),
        },
      },
    ]);
  });

  test("a single generative call settles all open preview conditions", async () => {
    let calls = 0;
    const preview = await decideTemplateConditions({
      fields,
      values,
      orgAIConfig: null,
      client: null,
      generator: async ({ questions, state }) => {
        calls += 1;
        expect(Object.keys(questions)).toEqual([
          "is_consumer",
          "has_arbitration",
        ]);
        expect(state).toEqual({
          details: JSON.stringify({ party_name: "Acme s.r.o." }),
        });
        return {
          model: "test-generative",
          output: {
            answers: [
              {
                id: "is_consumer",
                answer: { type: "noul", noul: 1 },
                evidence: null,
              },
              {
                id: "has_arbitration",
                answer: { type: "noul", noul: 0 },
                evidence: null,
              },
            ],
          },
        };
      },
    });
    expect(calls).toBe(1);
    expect(preview.conditions.map(({ decision }) => decision)).toEqual([
      { state: "decided", decidedBy: "generative_model", value: true },
      { state: "decided", decidedBy: "generative_model", value: false },
    ]);
  });

  test("a generative failure after an answer under the floor stays undecided", async () => {
    const decided = await decide(
      answering({ is_consumer: 0.55, has_arbitration: 0.95 }),
    );

    expect(decided.conditions.map(({ decision }) => decision)).toEqual([
      { state: "undecided", reason: "failed" },
      {
        state: "decided",
        decidedBy: "decision_model",
        value: true,
        probability: 0.95,
        confidence: expect.closeTo(0.9, 6),
      },
    ]);
  });

  test("a generative failure without a decision model leaves every condition undecided", async () => {
    const decided = await decide(null);

    expect(decided.model).toBeNull();
    expect(decided.conditions.map(({ decision }) => decision)).toEqual([
      { state: "undecided", reason: "failed" },
      { state: "undecided", reason: "failed" },
    ]);
  });

  test("a refused call leaves every condition undecided, not false", async () => {
    const decided = await decide(refusing(500));

    expect(decided.model).toBeNull();
    expect(decided.conditions.map(({ decision }) => decision)).toEqual([
      { state: "undecided", reason: "failed" },
      { state: "undecided", reason: "failed" },
    ]);
  });

  test("a supplied false wins and is omitted from the model's questions", async () => {
    const decided = await decideTemplateConditions({
      fields,
      values: { ...values, is_consumer: false },
      orgAIConfig: null,
      generator: async () => {
        throw new Error("Generation unavailable in this test");
      },
      client: answering({ has_arbitration: 0.9 }),
    });

    expect(decided.conditions).toEqual([
      {
        path: "is_consumer",
        label: "Consumer contract",
        decision: { state: "decided", decidedBy: "user", value: false },
      },
      {
        path: "has_arbitration",
        label: "has_arbitration",
        decision: {
          state: "decided",
          decidedBy: "decision_model",
          value: true,
          probability: 0.9,
          confidence: expect.closeTo(0.8, 6),
        },
      },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(
      expect.objectContaining({
        questions: {
          has_arbitration: expect.any(Object),
        },
      }),
    );
  });

  test("nested supplied booleans need no model", async () => {
    const decided = await decideTemplateConditions({
      fields: [
        {
          path: "client.is_consumer",
          inputType: "boolean",
          aiPrompt: CONSUMER_PROMPT,
        },
      ],
      values: { client: { is_consumer: true } },
      orgAIConfig: null,
      generator: async () => {
        throw new Error("Generation unavailable in this test");
      },
      client: answering({}),
    });

    expect(decided).toEqual({
      conditions: [
        {
          path: "client.is_consumer",
          label: "client.is_consumer",
          decision: { state: "decided", decidedBy: "user", value: true },
        },
      ],
      model: null,
    });
    expect(sent).toEqual([]);
  });

  test("supplied strings use the fill engine's condition truthiness", async () => {
    const decided = await decideTemplateConditions({
      fields,
      values: {
        party_name: "Acme s.r.o.",
        client_iban: "CZ0000",
        is_consumer: "yes",
        has_arbitration: "no",
      },
      orgAIConfig: null,
      generator: async () => {
        throw new Error("Generation unavailable in this test");
      },
      client: answering({}),
    });

    expect(decided).toEqual({
      conditions: [
        {
          path: "is_consumer",
          label: "Consumer contract",
          decision: { state: "decided", decidedBy: "user", value: true },
        },
        {
          path: "has_arbitration",
          label: "has_arbitration",
          decision: { state: "decided", decidedBy: "user", value: true },
        },
      ],
      model: null,
    });
    expect(sent).toEqual([]);
  });
});

describe("condition preview enters model gates only for open questions", () => {
  test.each(["empty", "supplied"] as const)(
    "%s conditions require no AI gates",
    async (mode) => {
      const { scopedDb } = createScopedDbMock({
        query: {
          templates: {
            findFirst: async () => ({
              manifest: {
                fields: mode === "empty" ? [] : fields,
                clauseSlots: [],
              },
            }),
          },
        },
      });
      let gates = 0;
      const result = await templateDecideConditionsLogic({
        scopedDb,
        organizationId: toSafeId<"organization">("org_preview"),
        templateId: toSafeId<"template">("tmpl_preview_conditional"),
        body: { values: { is_consumer: false, has_arbitration: true } },
        abortSignal: new AbortController().signal,
        runDecisions: async () => {
          gates += 1;
          return Result.err(
            new HandlerError({ status: 429, message: "Model work refused" }),
          );
        },
      });
      expect(Result.isOk(result)).toBe(true);
      expect(gates).toBe(0);
    },
  );

  test.each([429, 503] as const)(
    "an open condition preserves the gate refusal status %s",
    async (status) => {
      const { scopedDb } = createScopedDbMock({
        query: {
          templates: {
            findFirst: async () => ({ manifest: { fields, clauseSlots: [] } }),
          },
        },
      });
      const result = await templateDecideConditionsLogic({
        scopedDb,
        organizationId: toSafeId<"organization">("org_preview"),
        templateId: toSafeId<"template">("tmpl_preview_conditional"),
        body: { values: {} },
        abortSignal: new AbortController().signal,
        runDecisions: async ({ fields: planned }) => {
          expect(planned).toEqual(fields);
          return Result.err(
            new HandlerError({
              status,
              code: "internal_error",
              message: "Model work refused",
            }),
          );
        },
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.status).toBe(status);
      }
    },
  );
});

describe("templateDecideConditionsLogic access", () => {
  test("reads the template only within the caller's organization", async () => {
    const queried: unknown[] = [];
    const { scopedDb } = createScopedDbMock({
      query: {
        templates: {
          findFirst: async ({ where }: { where: unknown }) => {
            queried.push(where);
            // No row: the id names another organization's template.
            return await Promise.resolve(null);
          },
        },
      },
    });
    const organizationId = toSafeId<"organization">("org_caller");
    const templateId = toSafeId<"template">("tmpl_other_org");

    const result = await templateDecideConditionsLogic({
      runDecisions: async () => {
        throw new Error("Deterministic preview must not enter AI gates");
      },
      scopedDb,
      organizationId,
      templateId,
      body: { values: {} },
      abortSignal: new AbortController().signal,
    });

    expect(queried).toEqual([
      { id: { eq: templateId }, organizationId: { eq: organizationId } },
    ]);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.status).toBe(404);
    }
  });

  test("cancels the model call when the HTTP request is aborted", async () => {
    const { scopedDb } = createScopedDbMock({
      query: {
        templates: {
          findFirst: async () =>
            await Promise.resolve({
              manifest: { fields, clauseSlots: [] },
              templateClauses: [],
            }),
        },
      },
    });
    let modelSignal: AbortSignal | undefined;
    const modelStarted = Promise.withResolvers<undefined>();
    const client: DecisionModel = {
      provider: "typesafe",
      keySource: "byok",
      model: "jev-test",
      ask: async ({ abortSignal }) => {
        modelSignal = abortSignal;
        modelStarted.resolve(undefined);
        return await new Promise((resolve) => {
          abortSignal?.addEventListener(
            "abort",
            () =>
              resolve(
                Result.err(
                  new SystemOneError({
                    kind: "aborted",
                    message: "request aborted",
                  }),
                ),
              ),
            { once: true },
          );
        });
      },
    };
    const controller = new AbortController();

    const result = templateDecideConditionsLogic({
      runDecisions: async ({
        fields: plannedFields,
        values: plannedValues,
        abortSignal,
      }) =>
        Result.ok(
          await decideTemplateConditions({
            fields: plannedFields,
            values: plannedValues,
            abortSignal,
            orgAIConfig: null,
            client,
            generator: async () => {
              throw new Error("Generation unavailable in this test");
            },
          }),
        ),
      scopedDb,
      organizationId: toSafeId<"organization">("org_caller"),
      templateId: toSafeId<"template">("tmpl_conditioned"),
      body: { values },
      abortSignal: controller.signal,
    });

    await modelStarted.promise;
    expect(modelSignal?.aborted).toBe(false);
    controller.abort(new DOMException("Request cancelled", "AbortError"));
    expect(modelSignal?.aborted).toBe(true);
    expect(await rejectionOf(result)).toHaveProperty(
      "message",
      expect.stringContaining("Request cancelled"),
    );
  });
});

test("linked clauses without markers reuse the cached condition manifest", async () => {
  let reads = 0;
  const { scopedDb } = createScopedDbMock({
    query: {
      templates: {
        findFirst: async () => {
          reads++;
          if (reads > 1) {
            throw new TypeError(
              "Cached preview must not reload the template source",
            );
          }
          return {
            manifest: { fields, clauseSlots: [] },
            templateClauses: [
              {
                id: "link",
                clause: { body: [{ text: "Plain provision" }], versions: [] },
                clauseVariant: null,
                clauseVersion: { body: [{ text: "Pinned provision" }] },
              },
            ],
          };
        },
      },
    },
  });
  const result = await templateDecideConditionsLogic({
    runDecisions: async () => {
      throw new Error("Deterministic preview must not enter AI gates");
    },
    scopedDb,
    organizationId: toSafeId<"organization">("org_caller"),
    templateId: toSafeId<"template">("tmpl_cached"),
    body: { values: { is_consumer: true, has_arbitration: false } },
    abortSignal: new AbortController().signal,
  });
  expect(result.unwrap().conditions.map(({ decision }) => decision)).toEqual([
    { state: "decided", decidedBy: "user", value: true },
    { state: "decided", decidedBy: "user", value: false },
  ]);
  expect(reads).toBe(1);
});

for (const resolution of [
  "pinned",
  "latest",
  "explicit",
  "variant",
  "text-limit",
] as const) {
  test(`condition preview reads the ${resolution} slot body without loading template bytes`, async () => {
    const clauseId = toSafeId<"clause">("cls_preview");
    const versionId = toSafeId<"clauseVersion">("clsv_preview");
    const variantId = toSafeId<"clauseVariant">("clsvr_preview");
    const slot = {
      name: "Terms",
      patchKey: "@clause:Terms",
      versionModifier: {
        pinned: undefined,
        latest: "latest",
        explicit: "v2",
        variant: undefined,
        "text-limit": undefined,
      }[resolution],
    };
    const body = [
      { text: '{% if applicable | checkbox | ai("Does this apply?") %}' },
      { text: resolution === "text-limit" ? "Terms".repeat(50_001) : "Terms" },
      { text: "{% endif %}" },
    ];
    let templateReads = 0;
    let versionReads = 0;
    const { scopedDb } = createScopedDbMock({
      query: {
        templates: {
          findFirst: async () => {
            templateReads++;
            return { manifest: { fields: [], clauseSlots: [slot] } };
          },
        },
        templateClauses: {
          findMany: async () => [
            {
              slotName: "Terms",
              clauseId,
              clauseVariantId: resolution === "variant" ? variantId : null,
              clauseVariantLabel:
                resolution === "variant" ? "Alternative" : null,
              clauseVersionId: versionId,
              clause: { id: clauseId, title: "Terms" },
            },
          ],
        },
        clauses: {
          findMany: async () => [{ id: clauseId, currentVersion: 2 }],
        },
        clauseVariants: { findMany: async () => [{ id: variantId, body }] },
      },
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              versionReads++;
              return [{ id: versionId, clauseId, version: 2, body }];
            },
          }),
        }),
      }),
    });
    const result = await templateDecideConditionsLogic({
      runDecisions: async () => {
        throw new Error("Deterministic preview must not enter AI gates");
      },
      scopedDb,
      templateId: toSafeId<"template">("tmpl_preview"),
      organizationId: toSafeId<"organization">("org_preview"),
      body: { values: { applicable: true } },
      abortSignal: new AbortController().signal,
    });
    if (resolution === "text-limit") {
      expect(result.unwrap()).toEqual({
        conditions: [],
        model: null,
        preview: { state: "incomplete", reason: "text-limit" },
      });
    } else {
      expect(result.unwrap().conditions).toEqual([
        {
          path: "applicable",
          label: "applicable",
          decision: { state: "decided", decidedBy: "user", value: true },
        },
      ]);
    }
    expect(templateReads).toBe(1);
    expect(versionReads).toBe(resolution === "variant" ? 0 : 1);
  });
}

test("condition preview reports an incomplete state before reading an excessive slot set", async () => {
  const { scopedDb } = createScopedDbMock({
    query: {
      templates: {
        findFirst: async () => ({
          manifest: {
            fields: [],
            clauseSlots: Array.from({ length: 51 }, (_, i) => ({
              name: `Slot${i}`,
              patchKey: `@clause:Slot${i}`,
            })),
          },
        }),
      },
    },
  });
  const result = await templateDecideConditionsLogic({
    runDecisions: async () => {
      throw new Error("Deterministic preview must not enter AI gates");
    },
    scopedDb,
    templateId: toSafeId<"template">("tmpl_preview"),
    organizationId: toSafeId<"organization">("org_preview"),
    body: { values: {} },
    abortSignal: new AbortController().signal,
  });
  expect(result.unwrap()).toEqual({
    conditions: [],
    model: null,
    preview: { state: "incomplete", reason: "clause-limit" },
  });
});

test("mixed preview conditions reserve tools only for the referenced methodology", async () => {
  const result = await decideTemplateConditions({
    fields: [
      {
        path: "ordinary",
        inputType: "boolean",
        aiPrompt: "Is the principal a company?",
      },
      {
        path: "methodology",
        inputType: "boolean",
        aiPrompt:
          "Apply [Methodology](#stella-skill-ref=condition-methodology).",
      },
    ],
    values: { party_name: "Acme s.r.o." },
    orgAIConfig: null,
    client: answering({ ordinary: 0.94 }),
    generator: async ({ questions }) => {
      expect(Object.keys(questions)).toEqual(["methodology"]);
      expect(questions["methodology"]).toMatchObject({
        requiredCapability: "tools",
      });
      return {
        model: "test-generative",
        output: {
          answers: [
            {
              id: "methodology",
              answer: { type: "noul", noul: 1 },
              evidence: null,
            },
          ],
        },
      };
    },
  });
  expect(sent).toEqual([
    expect.objectContaining({ questions: { ordinary: expect.anything() } }),
  ]);
  expect(result.conditions.map(({ decision }) => decision)).toEqual([
    expect.objectContaining({ state: "decided", decidedBy: "decision_model" }),
    { state: "decided", decidedBy: "generative_model", value: true },
  ]);
});

test("preview catalog failure preserves supplied decisions without starting a model", async () => {
  let catalogReads = 0;
  const safeDb: SafeDb = async () => {
    catalogReads += 1;
    return Result.err(
      new DatabaseError({ message: "Fixture catalog unavailable" }),
    );
  };
  let generationCalls = 0;
  const result = await decideTemplateConditions({
    fields: [
      {
        path: "supplied",
        inputType: "boolean",
        aiPrompt: "Is this a company?",
      },
      {
        path: "skill",
        inputType: "boolean",
        aiPrompt:
          "Apply [Methodology](#stella-skill-ref=condition-methodology).",
      },
      {
        path: "ordinary",
        inputType: "boolean",
        aiPrompt: "Is this a consumer?",
      },
    ],
    values: { supplied: false },
    orgAIConfig: null,
    client: answering({ ordinary: 0.94 }),
    skillContext: {
      organizationId: toSafeId<"organization">("org_preview"),
      userId: toSafeId<"user">("user_preview"),
      safeDb,
    },
    generator: async () => {
      generationCalls += 1;
      return { model: "test-generative", output: { answers: [] } };
    },
  });
  expect(catalogReads).toBe(1);
  expect(sent).toEqual([]);
  expect(generationCalls).toBe(0);
  expect(result).toEqual({
    conditions: [
      {
        path: "supplied",
        label: "supplied",
        decision: { state: "decided", decidedBy: "user", value: false },
      },
      {
        path: "skill",
        label: "skill",
        decision: { state: "undecided", reason: "failed" },
      },
      {
        path: "ordinary",
        label: "ordinary",
        decision: { state: "undecided", reason: "failed" },
      },
    ],
    model: null,
  });
});
