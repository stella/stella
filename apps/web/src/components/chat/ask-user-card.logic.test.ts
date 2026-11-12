import { describe, expect, test } from "bun:test";

import type { AskUserQuestion } from "@stll/api-contract/chat-ask-user";

import {
  ASK_USER_MAX_CHIP_OPTION_LENGTH,
  ASK_USER_MAX_CHIP_OPTIONS,
  ASK_USER_OPTION_LAYOUT,
  askUserAnswersOf,
  type AskUserDraft,
  askUserDraftsFromAnswers,
  askUserOptionLayout,
  EMPTY_ASK_USER_DRAFT,
  initialAskUserDrafts,
  pickAllAskUserOptions,
  pickAskUserOption,
} from "@/components/chat/ask-user-card.logic";

const documents = {
  question: "Which documents should I read?",
  reason: "Only picked documents are read.",
  options: ["Lease A", "Lease B", "NDA C"],
  selection: "multiple",
} as const satisfies AskUserQuestion;
const side = {
  question: "Which side are you on?",
  reason: "Sets the tiers.",
  options: ["Landlord", "Tenant"],
} as const satisfies AskUserQuestion;
const deadline = {
  question: "When is the deadline?",
  reason: "Sets the schedule.",
} as const satisfies AskUserQuestion;

const draft = (entries: Partial<AskUserDraft>): AskUserDraft => ({
  ...EMPTY_ASK_USER_DRAFT,
  ...entries,
});

const optionsOf = (count: number, length = 5): string[] =>
  Array.from({ length: count }, (_, index) =>
    String(index).padEnd(length, "x"),
  );

describe("ask-user option layout", () => {
  test("lists a multiple-choice question only when it has many or long options", () => {
    const layoutOf = (options: string[], selection?: "multiple") =>
      askUserOptionLayout({
        question: "Which?",
        reason: "Scope.",
        options,
        ...(selection === undefined ? {} : { selection }),
      });

    expect(layoutOf(optionsOf(ASK_USER_MAX_CHIP_OPTIONS), "multiple")).toBe(
      ASK_USER_OPTION_LAYOUT.chips,
    );
    expect(layoutOf(optionsOf(ASK_USER_MAX_CHIP_OPTIONS + 1), "multiple")).toBe(
      ASK_USER_OPTION_LAYOUT.list,
    );
    expect(
      layoutOf(
        ["Short", "x".repeat(ASK_USER_MAX_CHIP_OPTION_LENGTH)],
        "multiple",
      ),
    ).toBe(ASK_USER_OPTION_LAYOUT.chips);
    expect(
      layoutOf(
        ["Short", "x".repeat(ASK_USER_MAX_CHIP_OPTION_LENGTH + 1)],
        "multiple",
      ),
    ).toBe(ASK_USER_OPTION_LAYOUT.list);
    // Length is counted in characters as read: each flag is one, not four
    // UTF-16 units.
    expect(
      layoutOf(["🇨🇿".repeat(ASK_USER_MAX_CHIP_OPTION_LENGTH)], "multiple"),
    ).toBe(ASK_USER_OPTION_LAYOUT.chips);
    expect(layoutOf(optionsOf(ASK_USER_MAX_CHIP_OPTIONS + 1))).toBe(
      ASK_USER_OPTION_LAYOUT.chips,
    );
  });
});

describe("ask-user answers", () => {
  test("toggles options of a multiple-choice question and replaces a single choice", () => {
    let picked = EMPTY_ASK_USER_DRAFT;
    picked = pickAskUserOption(documents, picked, "NDA C");
    picked = pickAskUserOption(documents, picked, "Lease A");
    picked = pickAskUserOption(documents, picked, "Lease B");
    picked = pickAskUserOption(documents, picked, "Lease B");
    expect(picked.picked).toEqual(["NDA C", "Lease A"]);

    let chosen = pickAskUserOption(side, EMPTY_ASK_USER_DRAFT, "Landlord");
    chosen = pickAskUserOption(side, chosen, "Tenant");
    chosen = pickAskUserOption(side, chosen, "Tenant");
    expect(chosen.picked).toEqual(["Tenant"]);

    expect(pickAllAskUserOptions(documents, picked).picked).toEqual(
      documents.options,
    );
  });

  test("gives one answer per question, ticked options in offered order", () => {
    expect(
      askUserAnswersOf([documents, side, deadline], {
        0: draft({ picked: ["NDA C", "Lease A"] }),
        1: draft({ picked: ["Tenant"] }),
        2: draft({ text: "End of May" }),
      }),
    ).toEqual([
      { question: documents.question, selected: ["Lease A", "NDA C"] },
      { question: side.question, answer: "Tenant" },
      { question: deadline.question, answer: "End of May" },
    ]);
    // The user's own words replace the ticked options.
    expect(
      askUserAnswersOf([documents], {
        0: draft({ picked: ["Lease A"], ownWords: true, text: "All leases" }),
      }),
    ).toEqual([{ question: documents.question, answer: "All leases" }]);
  });

  test("gives no answers until every question has one", () => {
    const answered = {
      0: draft({ picked: ["Lease A"] }),
      1: draft({ picked: ["Tenant"] }),
      2: draft({ text: "May" }),
    };
    expect(askUserAnswersOf([documents, side, deadline], answered)).not.toBe(
      null,
    );
    for (const unanswered of [
      { ...answered, 0: draft({}) },
      { ...answered, 1: draft({}) },
      { ...answered, 2: draft({ text: "  " }) },
      { ...answered, 0: draft({ picked: ["Lease A"], ownWords: true }) },
    ]) {
      expect(askUserAnswersOf([documents, side, deadline], unanswered)).toBe(
        null,
      );
    }
  });
});

describe("ask-user drafts", () => {
  test("opens at each question's default", () => {
    expect(
      initialAskUserDrafts([
        { ...side, default: "Tenant" },
        { ...side, default: "Neither" },
        { ...deadline, default: "Today" },
        documents,
      ]),
    ).toEqual({
      0: draft({ picked: ["Tenant"] }),
      1: draft({ ownWords: true, text: "Neither" }),
      2: draft({ text: "Today" }),
    });
  });

  test("Edit answers reopens stored answers, including ones stored before selections", () => {
    expect(
      askUserDraftsFromAnswers(
        [documents, side, side, deadline],
        [
          { question: documents.question, selected: ["Lease B", "NDA C"] },
          { question: side.question, answer: "Tenant" },
          { question: side.question, answer: "Both, jointly" },
          { question: deadline.question, answer: "" },
        ],
      ),
    ).toEqual({
      0: draft({ picked: ["Lease B", "NDA C"] }),
      1: draft({ picked: ["Tenant"] }),
      2: draft({ ownWords: true, text: "Both, jointly" }),
      3: EMPTY_ASK_USER_DRAFT,
    });
    // Free text stored on a multiple-choice question opens in its own words.
    expect(
      askUserDraftsFromAnswers(
        [documents],
        [{ question: documents.question, answer: "Every lease" }],
      ),
    ).toEqual({ 0: draft({ ownWords: true, text: "Every lease" }) });
  });
});
