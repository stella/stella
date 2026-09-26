import { describe, expect, test } from "bun:test";

import { TEXT_FIELD_TYPE } from "@stll/api-contract/case-law-text-field";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { findTableRows } from "@/components/workspaces/table/table-find.logic";
import type { Decision } from "@/features/case-law/components/decision-cells";
import {
  decisionFindRowText,
  isFindableDecisionColumn,
} from "@/features/case-law/decision-find.logic";
import {
  answerKey,
  questionColumnId,
} from "@/features/case-law/research/question-columns.logic";
import type {
  QuestionAnswer,
  QuestionColumn,
} from "@/features/case-law/research/question-columns.logic";

const decision = ({
  caseNumber,
  headnote,
  id,
}: {
  caseNumber: string;
  headnote: string | null;
  id: string;
}): Decision => ({
  caseNumber,
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  citationCount: 4,
  country: "CZ",
  court: "Nejvyšší soud",
  decisionDate: "2026-01-14",
  decisionType: "Rozsudek",
  ecli: null,
  headnote:
    headnote === null
      ? { type: TEXT_FIELD_TYPE.ABSENT, reason: "not_published" }
      : { type: TEXT_FIELD_TYPE.PRESENT, text: headnote, truncated: false },
  id,
  language: "cs",
  languageAlternates: [],
  slug: null,
});

const TERMINATION = decision({
  caseNumber: "21 Cdo 1/2026",
  headnote: "Výpověď z nájmu bytu musí být písemná.",
  id: "termination",
});
const EASEMENT = decision({
  caseNumber: "22 Cdo 2/2026",
  headnote: "Věcné břemeno chůze zaniká promlčením.",
  id: "easement",
});

const QUESTION: QuestionColumn = {
  content: { version: 1, type: "text" },
  id: "outcome",
  question: "How did the court rule?",
};
const NUMERIC_QUESTION: QuestionColumn = {
  content: { version: 1, type: "int" },
  id: "damages",
  question: "Damages awarded",
};

const answer = (columnId: string, decisionId: string, value: string) =>
  [
    answerKey(columnId, decisionId),
    {
      answer: { version: 1, type: "text", value },
      columnId,
      decisionId,
      failureReason: null,
      stale: false,
      state: "answered",
    } satisfies QuestionAnswer,
  ] as const;

const ANSWERS = new Map<string, QuestionAnswer>([
  answer("outcome", "termination", "Odvolání zamítnuto"),
  answer("outcome", "easement", "Rozsudek zrušen"),
]);

const NO_ANSWERS = new Map<string, QuestionAnswer>();
const NO_QUESTIONS: readonly QuestionColumn[] = [];

const find = ({
  columnIds,
  term,
}: {
  columnIds: readonly string[];
  term: string | null;
}) =>
  findTableRows({
    columnIds,
    rows: [TERMINATION, EASEMENT],
    rowText: (row) =>
      decisionFindRowText({
        answersByKey: ANSWERS,
        decision: row,
        questionColumns: [QUESTION, NUMERIC_QUESTION],
      }),
    term,
  });

describe("the columns a decision find can reach", () => {
  test("excludes what the cell renders differently from what it stores", () => {
    // Same reason the property model excludes dates and numbers: a date is
    // drawn in the reader's locale, a count digit-grouped, a language by name.
    expect(
      (["date", "citedBy", "language"] as const).map(isFindableDecisionColumn),
    ).toEqual([false, false, false]);
    expect(
      (["caseNumber", "court", "headnote", "summary"] as const).map(
        isFindableDecisionColumn,
      ),
    ).toEqual([true, true, true, true]);
  });
});

describe("what a decision row shows a find", () => {
  const text = decisionFindRowText({
    answersByKey: ANSWERS,
    decision: TERMINATION,
    questionColumns: [QUESTION, NUMERIC_QUESTION],
  });

  test("carries the headnote under both prose columns", () => {
    expect(text.get("headnote")).toBe("Výpověď z nájmu bytu musí být písemná.");
    expect(text.get("summary")).toBe(text.get("headnote"));
  });

  test("carries the terms of a row that carries no sentence", () => {
    // A classification is drawn as tags and must still be findable; reading
    // only the prose branch would make those rows silently unsearchable.
    const classified = decisionFindRowText({
      answersByKey: ANSWERS,
      decision: {
        ...TERMINATION,
        headnote: {
          type: "keywords",
          items: ["Nájem bytu", "Výpověď"],
          omitted: 0,
        },
      },
      questionColumns: [],
    });

    expect(classified.get("headnote")).toBe("Nájem bytu · Výpověď");
  });

  test("carries a headnote's points as the cell draws them", () => {
    // The cell draws the publisher's breaks, so the find reads them too: a
    // flattened reading would keep a row for a phrase spanning the break and
    // then mark nothing in it.
    const points = decisionFindRowText({
      answersByKey: ANSWERS,
      decision: {
        ...TERMINATION,
        headnote: {
          type: TEXT_FIELD_TYPE.PRESENT,
          text: "I. Vypoved z najmu.\nII. Pisemna forma.",
          truncated: false,
        },
      },
      questionColumns: [],
    });

    expect(points.get("headnote")).toBe(
      "I. Vypoved z najmu.\nII. Pisemna forma.",
    );
  });

  test("carries the answer a question column holds", () => {
    expect(text.get(questionColumnId("outcome"))).toBe("Odvolání zamítnuto");
  });

  test("carries nothing for a column a find cannot reach", () => {
    // A numeric answer is rendered digit-grouped, so a find over it would
    // match what the reader cannot see.
    expect(text.has("date")).toBe(false);
    expect(text.has(questionColumnId("damages"))).toBe(false);
  });

  test("carries an empty cell for a question no run has answered", () => {
    const unanswered = decisionFindRowText({
      answersByKey: NO_ANSWERS,
      decision: TERMINATION,
      questionColumns: [QUESTION],
    });

    expect(unanswered.get(questionColumnId("outcome"))).toBe("");
  });
});

describe("the rows a decision find leaves", () => {
  const everyColumn = ["headnote", "summary", "caseNumber", "court"];

  test("keeps a row matched in its headnote", () => {
    expect(find({ columnIds: everyColumn, term: "nájmu" })).toEqual([
      TERMINATION,
    ]);
  });

  test("keeps a row matched in an answer cell", () => {
    expect(
      find({
        columnIds: [...everyColumn, questionColumnId("outcome")],
        term: "zrušen",
      }),
    ).toEqual([EASEMENT]);
  });

  test("folds case the way the marks do", () => {
    expect(find({ columnIds: everyColumn, term: "VÝPOVĚĎ" })).toEqual([
      TERMINATION,
    ]);
  });

  test("drops a row whose match is outside the chosen columns", () => {
    // Narrowed to the headnote, an answer that would have matched no longer
    // counts: the picker's scope is the whole question.
    expect(find({ columnIds: ["headnote"], term: "zrušen" })).toEqual([]);
  });

  test("no term leaves the same list, by identity", () => {
    const decisions = [TERMINATION, EASEMENT];

    expect(
      findTableRows({
        columnIds: [],
        rows: decisions,
        rowText: (row) =>
          decisionFindRowText({
            answersByKey: ANSWERS,
            decision: row,
            questionColumns: NO_QUESTIONS,
          }),
        term: null,
      }),
    ).toBe(decisions);
  });
});
