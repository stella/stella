import { describe, expect, test } from "bun:test";

import type { ResearchQuestion } from "@/api/lib/case-law/research-answers";
import {
  exceedsSystemOneSourceBudget,
  resolveSystemOneOutcomes,
  splitSystemOneQuestions,
  systemOneSourcesFromPassages,
} from "@/api/lib/case-law/research-answers-system-one";
import type { AnswerOutcome } from "@/api/lib/typesafe/answer-questions";
import { SYSTEM_ONE_SOURCE_BUDGET_CHARS } from "@/api/lib/typesafe/answer-questions";

const outcome = { completedAt: "2026-09-17T10:00:00.000Z", model: "jev-1.13" };

const run = { ...outcome, retrieved: false };

const excerptByAnchor = new Map([
  ["b1", "Soud rozhodl, že smlouva je kupní smlouvou."],
]);

const columns = {
  type: {
    columnId: "col-type",
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
  },
  amount: {
    columnId: "col-amount",
    question: "What is the amount in dispute?",
    content: { version: 1, type: "int" },
  },
  summary: {
    columnId: "col-summary",
    question: "Summarize the holding.",
    content: { version: 1, type: "text" },
  },
} satisfies Record<string, ResearchQuestion>;

const askedFor = (question: ResearchQuestion) => {
  const { asked } = splitSystemOneQuestions([question]);
  return asked;
};

type AnsweredOutcome = Extract<AnswerOutcome, { state: "answered" }>;

const answered = (
  answer: AnsweredOutcome["answer"],
  overrides: Partial<AnsweredOutcome> = {},
): AnswerOutcome => ({
  state: "answered",
  answer,
  probability: 0.9,
  confidence: 0.9,
  sourceId: "b1",
  rationale: "Jev chose it.",
  ...overrides,
});

describe("splitSystemOneQuestions", () => {
  test("closed kinds are asked, text stays generative", () => {
    const { asked, generative } = splitSystemOneQuestions([
      columns.type,
      columns.amount,
      columns.summary,
    ]);
    expect(asked.map((question) => question.id)).toEqual([
      "col-type",
      "col-amount",
    ]);
    expect(asked.at(0)?.question).toBe(columns.type.question);
    expect(generative).toEqual([columns.summary]);
  });
});

describe("systemOneSourcesFromPassages", () => {
  test("passages are handed over as sources under the state budget", () => {
    const passages = [
      { anchorId: "b1", excerpt: " first " },
      { anchorId: "b2", excerpt: "second" },
    ];
    expect(exceedsSystemOneSourceBudget(passages)).toBe(false);
    expect(systemOneSourcesFromPassages(passages)).toEqual([
      { id: "b1", text: "first" },
      { id: "b2", text: "second" },
    ]);
  });

  test("a text over the budget is cut to it, in the order given", () => {
    const passages = [
      { anchorId: "b1", excerpt: "a".repeat(SYSTEM_ONE_SOURCE_BUDGET_CHARS) },
      { anchorId: "b2", excerpt: "b".repeat(100) },
    ];
    expect(exceedsSystemOneSourceBudget(passages)).toBe(true);
    const sources = systemOneSourcesFromPassages(passages);
    expect(sources.map((source) => source.id)).toEqual(["b1"]);
    expect(sources.at(0)?.text.length).toBe(SYSTEM_ONE_SOURCE_BUDGET_CHARS);
  });
});

describe("resolveSystemOneOutcomes", () => {
  test("an answer cites the source the model placed it in", () => {
    const resolved = resolveSystemOneOutcomes({
      questions: askedFor(columns.type),
      outcomes: new Map([["col-type", answered("Purchase agreement")]]),
      excerptByAnchor,
      run,
    });
    expect(resolved.fallbackColumnIds).toEqual([]);
    const settled = resolved.settled.at(0);
    expect(settled?.columnId).toBe("col-type");
    if (settled?.outcome.state !== "answered") {
      throw new Error("expected an answered cell");
    }
    expect(settled.outcome.answer).toEqual({
      version: 1,
      type: "single-select",
      value: "Purchase agreement",
    });
    expect(settled.outcome.run).toMatchObject({
      version: 1,
      model: "jev-1.13",
      retrieved: false,
      rationale: "Jev chose it.",
    });
    expect(settled.outcome.run.justification).toEqual({
      version: 1,
      blocks: [
        {
          kind: "decision-passage",
          anchorId: "b1",
          excerpt: "Soud rozhodl, že smlouva je kupní smlouvou.",
        },
      ],
    });
  });

  test("an answer with no source named carries no justification block", () => {
    const resolved = resolveSystemOneOutcomes({
      questions: askedFor(columns.type),
      outcomes: new Map([
        ["col-type", answered("Purchase agreement", { sourceId: null })],
      ]),
      excerptByAnchor,
      run,
    });
    const settled = resolved.settled.at(0);
    if (settled?.outcome.state !== "answered") {
      throw new Error("expected an answered cell");
    }
    expect(settled.outcome.run.justification.blocks).toEqual([]);
  });

  test("an unsure answer is left to the generative model", () => {
    const resolved = resolveSystemOneOutcomes({
      questions: askedFor(columns.type),
      outcomes: new Map([
        ["col-type", answered("Purchase agreement", { confidence: 0.55 })],
      ]),
      excerptByAnchor,
      run,
    });
    expect(resolved.settled).toEqual([]);
    expect(resolved.fallbackColumnIds).toEqual(["col-type"]);
  });

  test("a value outside the column's options is left to the generative model", () => {
    const resolved = resolveSystemOneOutcomes({
      questions: askedFor(columns.type),
      outcomes: new Map([["col-type", answered("Franchise")]]),
      excerptByAnchor,
      run,
    });
    expect(resolved.settled).toEqual([]);
    expect(resolved.fallbackColumnIds).toEqual(["col-type"]);
  });

  test("a question the kit could not plan falls back rather than failing", () => {
    const resolved = resolveSystemOneOutcomes({
      questions: askedFor(columns.amount),
      outcomes: new Map(),
      excerptByAnchor,
      run,
    });
    expect(resolved.settled).toEqual([]);
    expect(resolved.fallbackColumnIds).toEqual(["col-amount"]);
  });

  test("not stated writes an empty select cell and reports an empty int cell", () => {
    const notStated: AnswerOutcome = {
      state: "not_stated",
      confidence: 0.8,
      rationale: "Jev found no answer in the text (80% confidence).",
    };
    const select = resolveSystemOneOutcomes({
      questions: askedFor(columns.type),
      outcomes: new Map([["col-type", notStated]]),
      excerptByAnchor,
      run,
    });
    expect(select.settled.at(0)?.outcome).toMatchObject({
      state: "answered",
      answer: { version: 1, type: "single-select", value: null },
    });

    const int = resolveSystemOneOutcomes({
      questions: askedFor(columns.amount),
      outcomes: new Map([["col-amount", notStated]]),
      excerptByAnchor,
      run,
    });
    expect(int.settled.at(0)?.outcome).toEqual({
      state: "failed",
      failureReason: "not_stated",
    });
    expect(int.fallbackColumnIds).toEqual([]);
  });

  test("a retrieved state is stamped on every cell it answered", () => {
    const resolved = resolveSystemOneOutcomes({
      questions: askedFor(columns.type),
      outcomes: new Map([["col-type", answered("Lease")]]),
      excerptByAnchor,
      run: { ...outcome, retrieved: true },
    });
    const settled = resolved.settled.at(0);
    if (settled?.outcome.state !== "answered") {
      throw new Error("expected an answered cell");
    }
    expect(settled.outcome.run.retrieved).toBe(true);
  });
});
