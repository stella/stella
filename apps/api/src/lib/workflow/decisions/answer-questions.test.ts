import { describe, expect, test } from "bun:test";

import type { Fetcher } from "@stll/fetch";

import type {
  AnswerQuestion,
  AnswerSource,
  SystemOneAnswerPlan,
} from "@/api/lib/workflow/decisions/answer-questions";
import {
  decodeSystemOneAnswers,
  isSystemOneAnswerable,
  planSystemOneAnswers,
  SYSTEM_ONE_ANSWER_PLAN_MAX_QUESTIONS,
  SYSTEM_ONE_ANSWER_PLAN_MAX_REQUEST_BYTES,
  SYSTEM_ONE_SINGLE_SELECT_MAX_OPTIONS,
} from "@/api/lib/workflow/decisions/answer-questions";
import { decideMany } from "@/api/lib/workflow/decisions/decide";
import type { Decisions } from "@/api/lib/workflow/decisions/decide";
import {
  createSystemOneClient,
  DEFAULT_SYSTEM_ONE_MODEL,
  serializeSystemOneRequest,
} from "@/api/lib/workflow/decisions/system-one";

/**
 * The plan's questions asked over a fake wire, so what is decoded here is
 * what `decideMany` produces — the real binding and the real floor — rather
 * than hand-built decisions that could drift from it.
 */
const decisionsFor = async (
  plan: SystemOneAnswerPlan,
  answers: Record<string, unknown>,
): Promise<Decisions<SystemOneAnswerPlan["questions"]>> => {
  const fetcher: Fetcher = async () =>
    await Promise.resolve(
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers,
          usage: { input_tokens: 90, output_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  const { decisions } = await decideMany({
    id: "test.answer-questions",
    orgAIConfig: null,
    state: plan.state,
    questions: plan.questions,
    client: {
      ...createSystemOneClient({ apiKey: "key-test", fetcher }),
      keySource: "byok",
    },
  });
  return decisions;
};

const sources: AnswerSource[] = [
  {
    id: "p1",
    text: "Kupní smlouva byla uzavřena dne 12. 3. 2019 mezi prodávajícím a kupujícím.",
  },
  {
    id: "p2",
    text: "Kupní cena činí 1 250 000 Kč a je splatná do 30 dnů. Smlouva byla podepsána 1. dubna 2019.",
  },
];

const document = { caseNumber: "21 Cdo 1/2020", court: "Nejvyšší soud" };

const contractType: AnswerQuestion = {
  id: "col-type",
  question: "What kind of contract is this?",
  content: {
    version: 1,
    type: "single-select",
    options: [
      { value: "Purchase agreement", color: "gray" },
      { value: "Lease", color: "gray" },
    ],
    fallback: null,
  },
};

const choiceAnswer = (
  choice: string,
  probabilities: Record<string, number>,
  confidence = 0.9,
) => ({ type: "choice", choice, probabilities, confidence }) as const;

const selectQuestion = (
  id: string,
  type: "single-select" | "multi-select",
  optionCount: number,
  optionValue = (index: number): string => `Option ${String(index + 1)}`,
): AnswerQuestion => ({
  id,
  question: `Question ${id}`,
  content: {
    version: 1,
    type,
    options: Array.from({ length: optionCount }, (_, index) => ({
      value: optionValue(index),
      color: "gray",
    })),
    fallback: null,
  },
});

const requestBytes = (plan: SystemOneAnswerPlan): number =>
  new TextEncoder().encode(
    serializeSystemOneRequest({
      state: plan.state,
      model: DEFAULT_SYSTEM_ONE_MODEL,
      questions: plan.questions,
    }),
  ).byteLength;

describe("planSystemOneAnswers", () => {
  test("text columns are not System One questions", () => {
    expect(isSystemOneAnswerable({ version: 1, type: "text" })).toBe(false);
    expect(isSystemOneAnswerable({ version: 1, type: "date" })).toBe(true);
  });

  test("a single-select asks one choice over its options plus not-stated, and where it is", () => {
    const plan = planSystemOneAnswers({
      document,
      sources,
      language: "cs",
      questions: [contractType],
    });
    const value = plan.questions["col-type:value"];
    expect(value?.type).toBe("choice");
    if (value?.type !== "choice") {
      return;
    }
    expect(Object.keys(value.criteria)).toEqual(["o1", "o2", "__not_stated"]);
    expect(value.criteria["o1"]).toBe("Purchase agreement");
    const where = plan.questions["col-type:where"];
    expect(where?.type).toBe("choice");
    if (where?.type !== "choice") {
      return;
    }
    expect(Object.keys(where.criteria)).toEqual(["p1", "p2", "__none"]);
    expect(plan.state).toEqual({
      document,
      sources: sources.map(({ id, text }) => ({ id, text })),
    });
  });

  test("a select with no options is unplanned rather than asked against nothing", () => {
    const plan = planSystemOneAnswers({
      document,
      sources,
      language: "cs",
      questions: [
        {
          ...contractType,
          content: {
            version: 1,
            type: "single-select",
            options: [],
            fallback: null,
          },
        },
      ],
    });
    expect(plan.unplanned).toEqual(["col-type"]);
    expect(Object.keys(plan.questions)).toEqual([]);
  });

  test("reserves the final Choice slot for not-stated", () => {
    const atCap = planSystemOneAnswers({
      document,
      sources: [],
      language: "en",
      questions: [
        selectQuestion(
          "at-cap",
          "single-select",
          SYSTEM_ONE_SINGLE_SELECT_MAX_OPTIONS,
        ),
      ],
    });
    const overCap = planSystemOneAnswers({
      document,
      sources: [],
      language: "en",
      questions: [
        selectQuestion(
          "over-cap",
          "single-select",
          SYSTEM_ONE_SINGLE_SELECT_MAX_OPTIONS + 1,
        ),
      ],
    });

    const value = atCap.questions["at-cap:value"];
    expect(value?.type).toBe("choice");
    if (value?.type === "choice") {
      expect(Object.keys(value.criteria)).toHaveLength(
        SYSTEM_ONE_SINGLE_SELECT_MAX_OPTIONS + 1,
      );
    }
    expect(atCap.unplanned).toEqual([]);
    expect(overCap.unplanned).toEqual(["over-cap"]);
    expect(overCap.questions).toEqual({});
  });

  test("keeps a property atomic at the total question cap", () => {
    const atCap = selectQuestion(
      "at-cap",
      "multi-select",
      SYSTEM_ONE_ANSWER_PLAN_MAX_QUESTIONS,
    );
    const plan = planSystemOneAnswers({
      document,
      sources: [],
      language: "en",
      questions: [atCap, selectQuestion("overflow", "single-select", 1)],
    });

    expect(Object.keys(plan.questions)).toHaveLength(
      SYSTEM_ONE_ANSWER_PLAN_MAX_QUESTIONS,
    );
    expect(plan.plans.has("at-cap")).toBe(true);
    expect(plan.plans.has("overflow")).toBe(false);
    expect(plan.unplanned).toEqual(["overflow"]);

    const atomicOverflow = planSystemOneAnswers({
      document,
      sources: [{ id: "source", text: "short" }],
      language: "en",
      questions: [atCap],
    });
    expect(atomicOverflow.questions).toEqual({});
    expect(atomicOverflow.plans.size).toBe(0);
    expect(atomicOverflow.unplanned).toEqual(["at-cap"]);
  });

  test("accepts the serialized byte cap and leaves cap plus one unplanned", () => {
    const base = planSystemOneAnswers({
      document: {},
      sources: [],
      language: "en",
      questions: [selectQuestion("bytes", "single-select", 1, () => "")],
    });
    const padding =
      SYSTEM_ONE_ANSWER_PLAN_MAX_REQUEST_BYTES - requestBytes(base);
    expect(padding).toBeGreaterThan(0);
    const valueAtCap = "x".repeat(padding);
    const atCap = planSystemOneAnswers({
      document: {},
      sources: [],
      language: "en",
      questions: [
        selectQuestion("bytes", "single-select", 1, () => valueAtCap),
      ],
    });
    const overCap = planSystemOneAnswers({
      document: {},
      sources: [],
      language: "en",
      questions: [
        selectQuestion("bytes", "single-select", 1, () => `${valueAtCap}x`),
      ],
    });

    expect(requestBytes(atCap)).toBe(SYSTEM_ONE_ANSWER_PLAN_MAX_REQUEST_BYTES);
    expect(atCap.unplanned).toEqual([]);
    expect(overCap.questions).toEqual({});
    expect(overCap.plans.size).toBe(0);
    expect(overCap.unplanned).toEqual(["bytes"]);
  });

  test("a date column offers the dates found in the text, read in the text's language", () => {
    const plan = planSystemOneAnswers({
      document,
      sources,
      language: "cs",
      questions: [
        {
          id: "col-signed",
          question: "When was the contract signed?",
          content: { version: 1, type: "date" },
        },
      ],
    });
    const value = plan.questions["col-signed:value"];
    expect(value?.type).toBe("choice");
    if (value?.type !== "choice") {
      return;
    }
    expect(value.criteria).toMatchObject({
      c1: { value: "12. 3. 2019", in: "p1" },
      c2: { value: "1. dubna 2019", in: "p2" },
      __not_stated: expect.any(String),
    });
  });

  test("an int column offers the integers found in the text with the currency beside them", () => {
    const plan = planSystemOneAnswers({
      document,
      sources,
      language: "cs",
      questions: [
        {
          id: "col-price",
          question: "What is the purchase price?",
          content: { version: 1, type: "int" },
        },
      ],
    });
    const value = plan.questions["col-price:value"];
    expect(value?.type).toBe("choice");
    if (value?.type !== "choice") {
      return;
    }
    const offered = Object.values(value.criteria).flatMap((entry) =>
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      typeof entry["value"] === "string"
        ? [entry["value"]]
        : [],
    );
    expect(offered).toEqual(["1 250 000 Kč", "30"]);
  });

  test("a date column with no date in the text is unplanned", () => {
    const plan = planSystemOneAnswers({
      document,
      sources: [{ id: "p1", text: "No dates here." }],
      language: "en",
      questions: [
        {
          id: "col-signed",
          question: "When?",
          content: { version: 1, type: "date" },
        },
      ],
    });
    expect(plan.unplanned).toEqual(["col-signed"]);
  });
});

describe("decodeSystemOneAnswers", () => {
  test("a single-select answer maps back to the option value and the chosen source", async () => {
    const plan = planSystemOneAnswers({
      document,
      sources,
      language: "cs",
      questions: [contractType],
    });
    const outcomes = decodeSystemOneAnswers({
      plan,
      questions: [contractType],
      decisions: await decisionsFor(plan, {
        "col-type:value": choiceAnswer("o1", {
          o1: 0.93,
          o2: 0.04,
          __not_stated: 0.03,
        }),
        "col-type:where": choiceAnswer("p1", {
          p1: 0.8,
          p2: 0.15,
          __none: 0.05,
        }),
      }),
    });
    const outcome = outcomes.get("col-type");
    expect(outcome).toMatchObject({
      state: "answered",
      answer: "Purchase agreement",
      probability: 0.93,
      confidence: 0.9,
      sourceId: "p1",
    });
    if (outcome?.state !== "answered") {
      throw new Error("expected an answered outcome");
    }
    expect(outcome.rationale).toContain('"Purchase agreement"');
    expect(outcome.rationale).toContain("93%");
  });

  test("not-stated is reported as such, never as an option", async () => {
    const plan = planSystemOneAnswers({
      document,
      sources,
      language: "cs",
      questions: [contractType],
    });
    const outcomes = decodeSystemOneAnswers({
      plan,
      questions: [contractType],
      decisions: await decisionsFor(plan, {
        "col-type:value": choiceAnswer(
          "__not_stated",
          { o1: 0.1, o2: 0.1, __not_stated: 0.8 },
          0.75,
        ),
        "col-type:where": choiceAnswer("__none", {
          p1: 0.1,
          p2: 0.1,
          __none: 0.8,
        }),
      }),
    });
    expect(outcomes.get("col-type")).toMatchObject({
      state: "not_stated",
      confidence: 0.75,
    });
  });

  test("a multi-select keeps the options the model said yes to", async () => {
    const question: AnswerQuestion = {
      id: "col-parties",
      question: "Which parties are named?",
      content: {
        version: 1,
        type: "multi-select",
        options: [
          { value: "Seller", color: "gray" },
          { value: "Buyer", color: "gray" },
          { value: "Guarantor", color: "gray" },
        ],
        fallback: null,
      },
    };
    const plan = planSystemOneAnswers({
      document,
      sources,
      language: "cs",
      questions: [question],
    });
    expect(Object.keys(plan.questions)).toEqual([
      "col-parties:where",
      "col-parties:o1",
      "col-parties:o2",
      "col-parties:o3",
    ]);
    const outcomes = decodeSystemOneAnswers({
      plan,
      questions: [question],
      decisions: await decisionsFor(plan, {
        "col-parties:where": choiceAnswer("p1", {
          p1: 0.9,
          p2: 0.05,
          __none: 0.05,
        }),
        "col-parties:o1": { type: "noul", noul: 0.95 },
        "col-parties:o2": { type: "noul", noul: 0.9 },
        "col-parties:o3": { type: "noul", noul: 0.05 },
      }),
    });
    expect(outcomes.get("col-parties")).toMatchObject({
      state: "answered",
      answer: ["Seller", "Buyer"],
      probability: 0.9,
      sourceId: "p1",
    });
  });

  test("one option under the floor leaves the whole multi-select undecided", async () => {
    const question: AnswerQuestion = {
      id: "col-parties",
      question: "Which parties are named?",
      content: {
        version: 1,
        type: "multi-select",
        options: [
          { value: "Seller", color: "gray" },
          { value: "Buyer", color: "gray" },
        ],
        fallback: null,
      },
    };
    const plan = planSystemOneAnswers({
      document,
      sources,
      language: "cs",
      questions: [question],
    });
    const outcomes = decodeSystemOneAnswers({
      plan,
      questions: [question],
      decisions: await decisionsFor(plan, {
        "col-parties:where": choiceAnswer("p1", {
          p1: 0.9,
          p2: 0.05,
          __none: 0.05,
        }),
        "col-parties:o1": { type: "noul", noul: 0.95 },
        // A 0.6 yes is a 0.2 reading: the model is not sure either way.
        "col-parties:o2": { type: "noul", noul: 0.6 },
      }),
    });
    expect(outcomes.get("col-parties")).toEqual({
      state: "undecided",
      reason: "below-floor",
    });
  });

  test("an undecided value question is undecided, an undecided where-question only costs the citation", async () => {
    const plan = planSystemOneAnswers({
      document,
      sources,
      language: "cs",
      questions: [contractType],
    });
    const unsureValue = decodeSystemOneAnswers({
      plan,
      questions: [contractType],
      decisions: await decisionsFor(plan, {
        "col-type:value": choiceAnswer(
          "o1",
          { o1: 0.5, o2: 0.3, __not_stated: 0.2 },
          0.4,
        ),
        "col-type:where": choiceAnswer("p1", {
          p1: 0.8,
          p2: 0.15,
          __none: 0.05,
        }),
      }),
    });
    expect(unsureValue.get("col-type")).toEqual({
      state: "undecided",
      reason: "below-floor",
    });

    const unsureWhere = decodeSystemOneAnswers({
      plan,
      questions: [contractType],
      decisions: await decisionsFor(plan, {
        "col-type:value": choiceAnswer("o1", {
          o1: 0.93,
          o2: 0.04,
          __not_stated: 0.03,
        }),
        "col-type:where": choiceAnswer(
          "p1",
          { p1: 0.4, p2: 0.35, __none: 0.25 },
          0.3,
        ),
      }),
    });
    expect(unsureWhere.get("col-type")).toMatchObject({
      state: "answered",
      answer: "Purchase agreement",
      sourceId: null,
    });
  });

  test("with no decision model every planned question is undecided", async () => {
    const plan = planSystemOneAnswers({
      document,
      sources,
      language: "cs",
      questions: [contractType],
    });
    const { decisions } = await decideMany({
      id: "test.answer-questions",
      orgAIConfig: null,
      state: plan.state,
      questions: plan.questions,
      client: null,
    });
    const outcomes = decodeSystemOneAnswers({
      plan,
      questions: [contractType],
      decisions,
    });
    expect(outcomes.get("col-type")).toEqual({
      state: "undecided",
      reason: "no-backend",
    });
  });

  test("a date answer is the ISO reading of the chosen candidate, anchored to its source", async () => {
    const question: AnswerQuestion = {
      id: "col-signed",
      question: "When was the contract signed?",
      content: { version: 1, type: "date" },
    };
    const plan = planSystemOneAnswers({
      document,
      sources,
      language: "cs",
      questions: [question],
    });
    const outcomes = decodeSystemOneAnswers({
      plan,
      questions: [question],
      decisions: await decisionsFor(plan, {
        "col-signed:value": choiceAnswer("c2", {
          c1: 0.2,
          c2: 0.75,
          __not_stated: 0.05,
        }),
      }),
    });
    expect(outcomes.get("col-signed")).toMatchObject({
      state: "answered",
      answer: "2019-04-01",
      sourceId: "p2",
    });
  });

  test("an int answer carries the amount and the currency read beside it", async () => {
    const question: AnswerQuestion = {
      id: "col-price",
      question: "What is the purchase price?",
      content: { version: 1, type: "int" },
    };
    const plan = planSystemOneAnswers({
      document,
      sources,
      language: "cs",
      questions: [question],
    });
    const value = plan.questions["col-price:value"];
    if (value?.type !== "choice") {
      throw new Error("expected a choice");
    }
    const priceKey = Object.entries(value.criteria).find(
      ([, entry]) =>
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        entry["value"] === "1 250 000 Kč",
    )?.[0];
    if (priceKey === undefined) {
      throw new Error("price candidate missing");
    }
    const criteriaKeys = Object.keys(value.criteria);
    const alternativeProbability = 0.1 / (criteriaKeys.length - 1);
    const probabilities = Object.fromEntries(
      criteriaKeys.map((key) => [
        key,
        key === priceKey ? 0.9 : alternativeProbability,
      ]),
    );
    const outcomes = decodeSystemOneAnswers({
      plan,
      questions: [question],
      decisions: await decisionsFor(plan, {
        "col-price:value": choiceAnswer(priceKey, probabilities),
      }),
    });
    expect(outcomes.get("col-price")).toMatchObject({
      state: "answered",
      answer: { amount: 1_250_000, currency: "CZK" },
      sourceId: "p2",
    });
  });
});
