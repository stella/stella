import { describe, expect, test } from "bun:test";

import {
  answerKey,
  questionColumnSurface,
  questionRunSet,
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
): [string, QuestionAnswer] => [
  answerKey(columnId, decisionId),
  {
    columnId,
    decisionId,
    state,
    answer: state === "answered" ? { type: "yes_no", value: "yes" } : null,
    confidence: null,
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

  test("a refusal and a failure are finished answers, a pending cell is not", () => {
    const runSet = questionRunSet({
      answersByKey: new Map([
        answer("c1", "d1", "failed"),
        answer("c2", "d1", "pending"),
      ]),
      columnId: "c1",
      columns,
      pageDecisionIds: ["d1"],
      selectedDecisionIds: [],
    });

    expect(runSet.cells).toBe(0);

    const pending = questionRunSet({
      answersByKey: new Map([answer("c2", "d1", "pending")]),
      columnId: "c2",
      columns,
      pageDecisionIds: ["d1"],
      selectedDecisionIds: [],
    });

    expect(pending.cells).toBe(1);
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
      selectedDecisionIds: ["elsewhere"],
    });

    expect(runSet.decisionIds).toEqual([]);
    expect(runSet.cells).toBe(0);
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
