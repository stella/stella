import { describe, expect, test } from "bun:test";

import type {
  AnswerQuestion,
  AnswerSource,
} from "@/api/lib/typesafe/answer-questions";
import {
  decodeSystemOneAnswers,
  describeSystemOneReadings,
  isSystemOneAnswerable,
  planSystemOneAnswers,
} from "@/api/lib/typesafe/answer-questions";
import type {
  SystemOneAnswers,
  SystemOneQuestion,
} from "@/api/lib/typesafe/system-one";

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
  test("a single-select answer maps back to the option value and the chosen source", () => {
    const plan = planSystemOneAnswers({
      document,
      sources,
      language: "cs",
      questions: [contractType],
    });
    const answers: SystemOneAnswers<Record<string, SystemOneQuestion>> = {
      "col-type:value": choiceAnswer("o1", {
        o1: 0.93,
        o2: 0.04,
        __not_stated: 0.03,
      }),
      "col-type:where": choiceAnswer("p1", { p1: 0.8, p2: 0.15, __none: 0.05 }),
    };
    const outcomes = decodeSystemOneAnswers({
      plan,
      questions: [contractType],
      answers,
    });
    expect(outcomes.get("col-type")).toMatchObject({
      state: "answered",
      answer: "Purchase agreement",
      probability: 0.93,
      confidence: 0.9,
      sourceId: "p1",
    });
    expect(outcomes.get("col-type")?.rationale).toContain(
      '"Purchase agreement"',
    );
    expect(outcomes.get("col-type")?.rationale).toContain("93%");
  });

  test("not-stated is reported as such, never as an option", () => {
    const plan = planSystemOneAnswers({
      document,
      sources,
      language: "cs",
      questions: [contractType],
    });
    const outcomes = decodeSystemOneAnswers({
      plan,
      questions: [contractType],
      answers: {
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
      },
    });
    expect(outcomes.get("col-type")).toMatchObject({
      state: "not_stated",
      confidence: 0.75,
    });
  });

  test("a multi-select keeps the options the model said yes to", () => {
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
      answers: {
        "col-parties:where": choiceAnswer("p1", {
          p1: 0.9,
          p2: 0.05,
          __none: 0.05,
        }),
        "col-parties:o1": { type: "noul", noul: 0.95 },
        "col-parties:o2": { type: "noul", noul: 0.9 },
        "col-parties:o3": { type: "noul", noul: 0.05 },
      },
    });
    expect(outcomes.get("col-parties")).toMatchObject({
      state: "answered",
      answer: ["Seller", "Buyer"],
      probability: 0.9,
      sourceId: "p1",
    });
  });

  test("a date answer is the ISO reading of the chosen candidate, anchored to its source", () => {
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
      answers: {
        "col-signed:value": choiceAnswer("c2", {
          c1: 0.2,
          c2: 0.75,
          __not_stated: 0.05,
        }),
      },
    });
    expect(outcomes.get("col-signed")).toMatchObject({
      state: "answered",
      answer: "2019-04-01",
      sourceId: "p2",
    });
  });

  test("an int answer carries the amount and the currency read beside it", () => {
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
    const probabilities = Object.fromEntries(
      Object.keys(value.criteria).map((key) => [
        key,
        key === priceKey ? 0.9 : 0.01,
      ]),
    );
    const outcomes = decodeSystemOneAnswers({
      plan,
      questions: [question],
      answers: { "col-price:value": choiceAnswer(priceKey, probabilities) },
    });
    expect(outcomes.get("col-price")).toMatchObject({
      state: "answered",
      answer: { amount: 1_250_000, currency: "CZK" },
      sourceId: "p2",
    });
  });
});

describe("describeSystemOneReadings", () => {
  test("lists every question with what was chosen and how sure the model was", () => {
    const plan = planSystemOneAnswers({
      document,
      sources,
      language: "cs",
      questions: [contractType],
    });
    const outcomes = decodeSystemOneAnswers({
      plan,
      questions: [contractType],
      answers: {
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
      },
    });
    const readings: unknown = JSON.parse(
      describeSystemOneReadings({ questions: [contractType], outcomes }),
    );
    expect(readings).toEqual([
      {
        kind: "single-select",
        q: "What kind of contract is this?",
        state: "answered",
        value: "Purchase agreement",
        probability: 0.93,
        confidence: 0.9,
        source: "p1",
      },
    ]);
  });
});
