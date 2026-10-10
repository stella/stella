import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { createTranslator } from "use-intl";

import { CASE_LAW_RESEARCH_ANSWER_TYPES } from "@stll/api-contract";

import {
  columnDialogCopy,
  columnDialogLimitReached,
  columnDraftsChanged,
  makeEmptyDraft,
  questionColumnContent,
  questionDraft,
  settleColumnWrites,
} from "@/components/workspaces/bulk-add-columns.logic";
import type { Draft } from "@/components/workspaces/bulk-add-columns.logic";
import type { QuestionColumn } from "@/features/case-law/research/question-columns.logic";
import messages from "@/i18n/langs/en.json";

const NO_FILES: string[] = [];

const draftOf = (patch: Partial<Draft>): Draft => ({
  ...makeEmptyDraft(0, NO_FILES),
  ...patch,
});

describe("column dialog labels match the operation", () => {
  const t = createTranslator({ locale: "en", messages });

  test("adding columns keeps the add title and primary action", () => {
    const copy = columnDialogCopy({ type: "add" });
    expect(t(copy.title)).toBe("Add columns");
    expect(t(copy.primary)).toBe("Add columns");
  });

  test("editing a column names the edit and saves it", () => {
    const copy = columnDialogCopy({
      type: "edit",
      column: {
        id: "question",
        question: "What did the court hold?",
        content: { version: 1, type: "text" },
      },
    });
    expect(t(copy.title)).toBe("Edit column");
    expect(t(copy.primary)).toBe("Save");
  });
});

describe("column count caps apply only to creation", () => {
  test.each([false, true])(
    "editing stays available when the cap is %s",
    (reached) => {
      expect(
        columnDialogLimitReached(
          {
            type: "edit",
            column: {
              id: "question",
              question: "What did the court hold?",
              content: { version: 1, type: "text" },
            },
          },
          reached,
        ),
      ).toBe(false);
    },
  );

  test.each([false, true])(
    "adding respects whether the cap is %s",
    (reached) => {
      expect(columnDialogLimitReached({ type: "add" }, reached)).toBe(reached);
    },
  );
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

describe("what a partly refused batch leaves behind", () => {
  test("a column that committed is read back even though a sibling failed", async () => {
    const committed: string[] = [];
    let refreshes = 0;
    const refused = new Error("Question column limit reached");

    const settled = await settleColumnWrites({
      writes: [
        async () => {
          committed.push("first");
        },
        async () => {
          throw refused;
        },
      ],
      refresh: async () => {
        refreshes += 1;
      },
    });

    expect(Result.isError(settled) ? settled.error : null).toBe(refused);
    expect(committed).toEqual(["first"]);
    expect(refreshes).toBe(1);
  });

  test("the refresh runs once every write has settled", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const settled = settleColumnWrites({
      writes: [
        async () => {
          await blocked;
          order.push("write");
        },
      ],
      refresh: async () => {
        order.push("refresh");
      },
    });

    expect(order).toEqual([]);
    release?.();
    await settled;
    expect(order).toEqual(["write", "refresh"]);
  });
});

describe("column draft opening baseline", () => {
  test("stored questions and new drafts start clean, detect every field edit, and become clean on revert", () => {
    const initial = draftOf({
      name: "Stored question",
      contentType: "single-select",
      options: [{ value: "yes", color: "green" }],
    });
    const patches = {
      id: 1,
      name: "Changed question",
      prompt: "Changed prompt",
      mentions: ["mention"],
      fileIds: ["file"],
      contentType: "text",
      tool: "manual-input",
      options: [{ value: "no", color: "red" }],
      fallback: "fallback",
    } satisfies Draft;
    expect(columnDraftsChanged([initial], [initial])).toBe(false);
    const blank = makeEmptyDraft(0, NO_FILES);
    expect(columnDraftsChanged([blank], [blank])).toBe(false);
    for (const [field, value] of Object.entries(patches)) {
      const changed = { ...initial, [field]: value };
      expect(columnDraftsChanged([changed], [initial])).toBe(true);
      expect(columnDraftsChanged([structuredClone(initial)], [initial])).toBe(
        false,
      );
    }
    expect(columnDraftsChanged([initial, blank], [initial])).toBe(true);
  });
});
