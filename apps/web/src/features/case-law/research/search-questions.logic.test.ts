import { describe, expect, test } from "bun:test";

import { CASE_LAW_RESEARCH_COLUMNS_PER_ORGANIZATION_MAX } from "@stll/api-contract";

import { questionRunSet } from "./question-columns.logic";
import type { QuestionAnswer, QuestionColumn } from "./question-columns.logic";
import {
  questionsOnSearch,
  searchQuestionsParam,
  withoutQuestionOnSearch,
  withQuestionsOnSearch,
} from "./search-questions.logic";

const column = (id: string): QuestionColumn => ({
  id,
  question: `question ${id}`,
  content: { version: 1, type: "text" },
});

/** The organization's questions, in the order the server keeps them. */
const library = ["c1", "c2", "c3", "c4"].map(column);

/** Every ordering of every subset, so each case below covers the input class. */
const arrangements = (items: readonly string[]): string[][] => {
  if (items.length === 0) {
    return [[]];
  }
  const out: string[][] = [[]];
  for (const [index, item] of items.entries()) {
    const rest = items.filter((_, other) => other !== index);
    for (const tail of arrangements(rest)) {
      out.push([item, ...tail]);
    }
  }
  return out;
};

/** URL lists: known ids, ids the organization does not hold, and repeats. */
const urlLists = arrangements(["c3", "gone", "c1", "c4"]).flatMap((list) => [
  list,
  [...list, ...list.slice(0, 1)],
]);

const ids = (columns: readonly QuestionColumn[]) =>
  columns.map((shown) => shown.id);

describe("which questions a search draws", () => {
  test("the URL's order, each known id once, unknown ids not drawn", () => {
    const known = new Set(ids(library));
    for (const shownIds of urlLists) {
      const { shown } = questionsOnSearch({ library, shownIds });

      expect(ids(shown)).toEqual([
        ...new Set(shownIds.filter((id) => known.has(id))),
      ]);
    }
  });

  test("everything else the organization holds is offered, in its order", () => {
    for (const shownIds of urlLists) {
      const { shown, addable } = questionsOnSearch({ library, shownIds });
      const drawn = new Set(ids(shown));

      expect(ids(addable)).toEqual(ids(library).filter((id) => !drawn.has(id)));
    }
  });

  // A signed-out reader, or a list still loading, has no library: the ids in
  // the URL stay there for when it arrives, and nothing is drawn meanwhile.
  test("with no library nothing is drawn and nothing is offered", () => {
    for (const shownIds of urlLists) {
      expect(questionsOnSearch({ library: [], shownIds })).toEqual({
        shown: [],
        addable: [],
      });
    }
  });

  test("a new search draws none and offers them all", () => {
    expect(questionsOnSearch({ library, shownIds: [] })).toEqual({
      shown: [],
      addable: library,
    });
  });
});

describe("the list the URL carries", () => {
  test("each id once, first spelling wins, empty entries dropped", () => {
    expect(searchQuestionsParam([" c2 ", "c1", "", "c2", "  "])).toEqual([
      "c2",
      "c1",
    ]);
  });

  test("an empty list leaves the URL", () => {
    expect(searchQuestionsParam([])).toBeUndefined();
    expect(searchQuestionsParam(["", " "])).toBeUndefined();
  });

  // Typed or crawled links: an entry no id is that long is junk, and a list
  // longer than any organization's is cut rather than refused.
  test("junk entries are dropped and the list is capped", () => {
    const many = Array.from(
      { length: CASE_LAW_RESEARCH_COLUMNS_PER_ORGANIZATION_MAX + 5 },
      (_, index) => `c${index}`,
    );

    expect(searchQuestionsParam(["x".repeat(65), "c1"])).toEqual(["c1"]);
    expect(searchQuestionsParam(many)).toEqual(
      many.slice(0, CASE_LAW_RESEARCH_COLUMNS_PER_ORGANIZATION_MAX),
    );
  });

  test("adding appends after what is shown, without repeating", () => {
    for (const shownIds of urlLists) {
      const next = withQuestionsOnSearch(shownIds, ["c2", "c1"]) ?? [];

      expect(next.slice(0, new Set(shownIds).size)).toEqual([
        ...new Set(shownIds),
      ]);
      expect(new Set(next)).toEqual(new Set([...shownIds, "c2", "c1"]));
      expect(next.length).toBe(new Set(next).size);
    }
  });

  test("removing drops that id alone and keeps the order", () => {
    for (const shownIds of urlLists) {
      for (const removed of new Set(shownIds)) {
        expect(withoutQuestionOnSearch(shownIds, removed) ?? []).toEqual(
          [...new Set(shownIds)].filter((id) => id !== removed),
        );
      }
    }
  });
});

describe("what a run on a search covers", () => {
  const page = ["d1", "d2"];

  // "Answer all" asks the questions on screen; a question the organization
  // holds but this search does not show must never be billed for.
  test("only the questions this search shows", () => {
    for (const shownIds of urlLists) {
      const { shown } = questionsOnSearch({ library, shownIds });
      const runSet = questionRunSet({
        answersByKey: new Map<string, QuestionAnswer>(),
        columns: shown,
        pageDecisionIds: page,
        selectedDecisionIds: [],
      });

      expect(runSet.columnIds).toEqual(ids(shown));
      expect(runSet.cells).toBe(shown.length * page.length);
    }
  });
});
