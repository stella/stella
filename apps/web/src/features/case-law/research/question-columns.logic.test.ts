import { describe, expect, test } from "bun:test";

import {
  answerNeedsRun,
  CASE_LAW_RESEARCH_ANSWER_STATES,
  CASE_LAW_RESEARCH_RUN_DECISIONS_MAX,
} from "@stll/api-contract";
import type { ResearchAnswerRunCheck } from "@stll/api-contract";

import {
  answerKey,
  questionColumnSurface,
  questionEditDiscardsAnswers,
  questionRunSet,
  researchRunBatches,
} from "./question-columns.logic";
import type { QuestionAnswer, QuestionColumn } from "./question-columns.logic";

const column = (id: string): QuestionColumn => ({
  id,
  question: `question ${id}`,
  answerType: "yes_no",
});

const answer = (
  columnId: string,
  decisionId: string,
  state: QuestionAnswer["state"],
  stale = false,
): [string, QuestionAnswer] => [
  answerKey(columnId, decisionId),
  {
    columnId,
    decisionId,
    state,
    stale,
    answer: state === "answered" ? { type: "yes_no", value: "yes" } : null,
  },
];

const columns = [column("c1"), column("c2")];
const page = ["d1", "d2", "d3"];

describe("what a run covers", () => {
  test("an untouched page is every cell of it", () => {
    const runSet = questionRunSet({
      answersByKey: new Map(),
      columns,
      pageDecisionIds: page,
      selectedDecisionIds: [],
    });

    expect(runSet.decisionIds).toEqual(page);
    expect(runSet.columnIds).toEqual(["c1", "c2"]);
    expect(runSet.cells).toBe(6);
  });

  test("a cell that already holds an answer is not asked again", () => {
    const runSet = questionRunSet({
      answersByKey: new Map([answer("c1", "d1", "answered")]),
      columns,
      pageDecisionIds: page,
      selectedDecisionIds: [],
    });

    expect(runSet.cells).toBe(5);
    expect(runSet.decisionIds).toEqual(page);
  });

  test("a decision whose every cell is answered drops out of the run", () => {
    const runSet = questionRunSet({
      answersByKey: new Map([
        answer("c1", "d1", "answered"),
        answer("c2", "d1", "not_allowed"),
      ]),
      columns,
      pageDecisionIds: page,
      selectedDecisionIds: [],
    });

    expect(runSet.decisionIds).toEqual(["d2", "d3"]);
    expect(runSet.cells).toBe(4);
  });

  /**
   * The count the reader confirms and the count the queue produces are one
   * policy, so a cell the server would skip is never billed in the estimate
   * and a cell it would retry is never left out of it.
   */
  test("a cell runs exactly when the queue's own policy says it does", () => {
    const cases = [
      // A failure is retried; a refusal is the source's terms, which a re-run
      // cannot change; an answer is the cache that makes paging back free.
      { state: "failed", stale: false },
      { state: "not_allowed", stale: false },
      { state: "answered", stale: false },
      // A live pending cell belongs to another run; a quiet one is a run that
      // died and may be claimed.
      { state: "pending", stale: false },
      { state: "pending", stale: true },
    ] as const satisfies readonly ResearchAnswerRunCheck[];

    expect(
      CASE_LAW_RESEARCH_ANSWER_STATES.every((state) =>
        cases.some((entry) => entry.state === state),
      ),
    ).toBe(true);

    for (const { stale, state } of cases) {
      const runSet = questionRunSet({
        answersByKey: new Map([answer("c1", "d1", state, stale)]),
        columnId: "c1",
        columns,
        pageDecisionIds: ["d1"],
        selectedDecisionIds: [],
      });

      expect(runSet.cells).toBe(answerNeedsRun({ state, stale }) ? 1 : 0);
    }
  });

  test("one column runs only its own cells", () => {
    const runSet = questionRunSet({
      answersByKey: new Map(),
      columnId: "c2",
      columns,
      pageDecisionIds: page,
      selectedDecisionIds: [],
    });

    expect(runSet.columnIds).toEqual(["c2"]);
    expect(runSet.cells).toBe(3);
  });

  test("picking rows narrows the run to them", () => {
    const runSet = questionRunSet({
      answersByKey: new Map(),
      columns,
      pageDecisionIds: page,
      selectedDecisionIds: ["d3", "d1"],
    });

    expect(runSet.decisionIds).toEqual(["d1", "d3"]);
    expect(runSet.cells).toBe(4);
  });

  test("a picked row that is not on this page is not run", () => {
    const runSet = questionRunSet({
      answersByKey: new Map(),
      columns,
      pageDecisionIds: page,
      selectedDecisionIds: ["d2", "elsewhere"],
    });

    expect(runSet.decisionIds).toEqual(["d2"]);
    expect(runSet.cells).toBe(2);
  });

  /**
   * A selection outlives the rows it named: changing the query or a facet
   * redraws the page without clearing it. A selection none of whose rows
   * survived is not an empty run, it is no selection.
   */
  test("a selection the page no longer holds falls back to the page", () => {
    const runSet = questionRunSet({
      answersByKey: new Map(),
      columns,
      pageDecisionIds: page,
      selectedDecisionIds: ["elsewhere"],
    });

    expect(runSet.decisionIds).toEqual(page);
    expect(runSet.cells).toBe(6);
  });

  test("an empty page has nothing to run, selection or not", () => {
    for (const selectedDecisionIds of [[], ["d1"]]) {
      expect(
        questionRunSet({
          answersByKey: new Map(),
          columns,
          pageDecisionIds: [],
          selectedDecisionIds,
        }),
      ).toEqual({ columnIds: ["c1", "c2"], decisionIds: [], cells: 0 });
    }
  });

  test("forcing asks every cell again", () => {
    const runSet = questionRunSet({
      answersByKey: new Map([
        answer("c1", "d1", "answered"),
        answer("c2", "d1", "answered"),
      ]),
      columns,
      force: true,
      pageDecisionIds: page,
      selectedDecisionIds: [],
    });

    expect(runSet.cells).toBe(6);
  });

  test("a run never covers more cells than rows times columns", () => {
    const states: QuestionAnswer["state"][] = [
      "answered",
      "pending",
      "failed",
      "not_allowed",
    ];
    for (const state of states) {
      const runSet = questionRunSet({
        answersByKey: new Map([answer("c1", "d2", state)]),
        columns,
        pageDecisionIds: page,
        selectedDecisionIds: [],
      });

      expect(runSet.cells).toBeLessThanOrEqual(page.length * columns.length);
      expect(runSet.decisionIds.length).toBeLessThanOrEqual(page.length);
    }
  });

  test("with no columns there is nothing to run", () => {
    const runSet = questionRunSet({
      answersByKey: new Map(),
      columns: [],
      pageDecisionIds: page,
      selectedDecisionIds: [],
    });

    expect(runSet).toEqual({ columnIds: [], decisionIds: [], cells: 0 });
  });
});

describe("how a run reaches the endpoint", () => {
  const ids = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `d${index}`);

  test("a page fits in one request", () => {
    expect(researchRunBatches([])).toEqual([]);
    expect(
      researchRunBatches(ids(CASE_LAW_RESEARCH_RUN_DECISIONS_MAX)),
    ).toHaveLength(1);
  });

  test("no batch is longer than the endpoint accepts", () => {
    for (const count of [1, 99, 100, 101, 250, 1000]) {
      for (const batch of researchRunBatches(ids(count))) {
        expect(batch.length).toBeGreaterThan(0);
        expect(batch.length).toBeLessThanOrEqual(
          CASE_LAW_RESEARCH_RUN_DECISIONS_MAX,
        );
      }
    }
  });

  test("the batches are the run set, in order and whole", () => {
    for (const count of [0, 1, 100, 101, 349]) {
      const decisionIds = ids(count);

      expect(researchRunBatches(decisionIds).flat()).toEqual(decisionIds);
    }
  });
});

describe("who is shown question columns", () => {
  test("a reader with an organization sees them", () => {
    expect(
      questionColumnSurface({ columns, hasActiveOrganization: true }),
    ).toEqual({ type: "available", columns });
  });

  test("a reader without one sees no column and no control", () => {
    expect(
      questionColumnSurface({ columns, hasActiveOrganization: false }),
    ).toEqual({ type: "hidden" });
  });
});

describe("when saving a question throws its answers away", () => {
  const stored = {
    question: "Was the termination valid?",
    answerType: "yes_no",
  } as const;

  test("adding a question has nothing to discard", () => {
    expect(
      questionEditDiscardsAnswers({ draft: { ...stored }, stored: undefined }),
    ).toBe(false);
  });

  test("saving an unchanged question keeps them", () => {
    expect(questionEditDiscardsAnswers({ draft: { ...stored }, stored })).toBe(
      false,
    );
  });

  // The server trims before it compares, so whitespace alone is not a change.
  test("whitespace around the same wording is not a change", () => {
    expect(
      questionEditDiscardsAnswers({
        draft: { ...stored, question: `  ${stored.question}\n` },
        stored,
      }),
    ).toBe(false);
  });

  test("rewording discards them", () => {
    expect(
      questionEditDiscardsAnswers({
        draft: { ...stored, question: "Was the notice period observed?" },
        stored,
      }),
    ).toBe(true);
  });

  test("a different kind of answer discards them", () => {
    expect(
      questionEditDiscardsAnswers({
        draft: { ...stored, answerType: "text" },
        stored,
      }),
    ).toBe(true);
  });
});
