import { describe, expect, test } from "bun:test";

import { CASE_LAW_RESEARCH_ANSWER_TYPES } from "@stll/api-contract";

import {
  makeEmptyDraft,
  questionColumnContent,
  questionDraft,
} from "@/components/workspaces/bulk-add-columns.logic";
import type { Draft } from "@/components/workspaces/bulk-add-columns.logic";
import type { QuestionColumn } from "@/features/case-law/research/question-columns.logic";

const NO_FILES: string[] = [];

const draftOf = (patch: Partial<Draft>): Draft => ({
  ...makeEmptyDraft(0, NO_FILES),
  ...patch,
});

describe("what an organisation draft becomes", () => {
  test("every kind a question may be asked in is stored as that kind", () => {
    for (const answerType of CASE_LAW_RESEARCH_ANSWER_TYPES) {
      const content = questionColumnContent(
        draftOf({
          contentType: answerType,
          options: [{ value: "yes", color: "green" }],
        }),
      );

      expect(content.type).toBe(answerType);
    }
  });

  test("a select carries its options and never a fallback", () => {
    const content = questionColumnContent(
      draftOf({
        contentType: "single-select",
        options: [
          { value: "yes", color: "green" },
          { value: "no", color: "red" },
        ],
        // A fallback the composer never offers for a question; if one leaked
        // in from a shared draft it must not reach the stored column.
        fallback: "yes",
      }),
    );

    expect(content).toEqual({
      version: 1,
      type: "single-select",
      options: [
        { value: "yes", color: "green" },
        { value: "no", color: "red" },
      ],
      fallback: null,
    });
  });

  // Both directions: the composer must offer every kind a question may be
  // asked in, and no kind it may not. The type side of this is asserted where
  // the mapping lives; this is the runtime half.
  test("the composer's kinds and the answer kinds are the same set", () => {
    const stored = CASE_LAW_RESEARCH_ANSWER_TYPES.map(
      (answerType) =>
        questionColumnContent(draftOf({ contentType: answerType })).type,
    );

    expect(stored.toSorted()).toEqual(
      [...CASE_LAW_RESEARCH_ANSWER_TYPES].toSorted(),
    );
  });
});

describe("editing a stored question", () => {
  const columns: readonly QuestionColumn[] = [
    {
      id: "q-text",
      question: "What did the court hold?",
      content: { version: 1, type: "text" },
    },
    {
      id: "q-date",
      question: "When was the contract signed?",
      content: { version: 1, type: "date" },
    },
    {
      id: "q-select",
      question: "Was the termination valid?",
      content: {
        version: 1,
        type: "single-select",
        options: [
          { value: "yes", color: "green" },
          { value: "no", color: "red" },
        ],
        fallback: null,
      },
    },
  ];

  // The composer is the only editor a question has, so a question loaded into
  // it and saved unchanged must come back exactly as it was stored.
  test("the composer round trip leaves a stored question untouched", () => {
    for (const column of columns) {
      expect(questionColumnContent(questionDraft(column))).toEqual(
        column.content,
      );
    }
  });

  test("the question's wording seeds the card's name", () => {
    expect(columns.map((column) => questionDraft(column).name)).toEqual(
      columns.map((column) => column.question),
    );
  });
});
