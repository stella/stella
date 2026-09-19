import { Result } from "better-result";
import { beforeEach, describe, expect, test } from "bun:test";

import type { Fetcher } from "@stll/fetch";

import { toSafeId } from "@/api/lib/branded-types";
import type { FieldMeta } from "@/api/lib/docx/types";
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

  test("an answer under the confidence floor stays undecided", async () => {
    const decided = await decide(
      answering({ is_consumer: 0.55, has_arbitration: 0.95 }),
    );

    expect(decided.conditions.map(({ decision }) => decision)).toEqual([
      { state: "undecided", reason: "below-floor" },
      {
        state: "decided",
        decidedBy: "decision_model",
        value: true,
        probability: 0.95,
        confidence: expect.closeTo(0.9, 6),
      },
    ]);
  });

  test("with no decision model every condition is no-backend", async () => {
    const decided = await decide(null);

    expect(decided.model).toBeNull();
    expect(decided.conditions.map(({ decision }) => decision)).toEqual([
      { state: "undecided", reason: "no-backend" },
      { state: "undecided", reason: "no-backend" },
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
      scopedDb,
      organizationId,
      templateId,
      body: { values: {} },
      orgAIConfig: null,
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
            await Promise.resolve({ manifest: { fields } }),
        },
      },
    });
    let modelSignal: AbortSignal | undefined;
    const modelStarted = Promise.withResolvers<undefined>();
    const client: DecisionModel = {
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
      scopedDb,
      organizationId: toSafeId<"organization">("org_caller"),
      templateId: toSafeId<"template">("tmpl_conditioned"),
      body: { values },
      orgAIConfig: null,
      abortSignal: controller.signal,
      client,
    });

    await modelStarted.promise;
    expect(modelSignal?.aborted).toBe(false);
    controller.abort(new DOMException("Request cancelled", "AbortError"));
    expect(modelSignal?.aborted).toBe(true);
    expect(result).rejects.toThrow("Request cancelled");
  });
});
