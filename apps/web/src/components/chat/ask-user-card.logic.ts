import { panic } from "better-result";

import {
  ASK_USER_SELECTION,
  type AskUserAnswer,
  askUserAnswersRefusal,
  type AskUserQuestion,
  askUserSelectionOf,
} from "@stll/api-contract/chat-ask-user";

/**
 * What the user has entered for one question: the options picked, and their
 * own words, which stand in for the options while `ownWords` is on (or when
 * the question has no options).
 */
export type AskUserDraft = {
  picked: readonly string[];
  text: string;
  ownWords: boolean;
};

export const EMPTY_ASK_USER_DRAFT: AskUserDraft = Object.freeze({
  picked: Object.freeze([]),
  text: "",
  ownWords: false,
});

export const ASK_USER_OPTION_LAYOUT = {
  chips: "chips",
  list: "list",
} as const;

export type AskUserOptionLayout =
  (typeof ASK_USER_OPTION_LAYOUT)[keyof typeof ASK_USER_OPTION_LAYOUT];

/** More options than this, on a multiple-choice question, render as a list. */
export const ASK_USER_MAX_CHIP_OPTIONS = 10;
/** An option longer than this, in characters as read, renders as a list row. */
export const ASK_USER_MAX_CHIP_OPTION_LENGTH = 40;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const visibleLength = (text: string): number =>
  [...graphemes.segment(text)].length;

/** A question without `options` is answered in the user's own words. */
export const askUserOptionsOf = (
  question: AskUserQuestion,
): readonly string[] => question.options ?? [];

/** A multiple-choice question with many or long options reads as a list. */
export const askUserOptionLayout = (
  question: AskUserQuestion,
): AskUserOptionLayout => {
  const options = askUserOptionsOf(question);
  return askUserSelectionOf(question) === ASK_USER_SELECTION.multiple &&
    (options.length > ASK_USER_MAX_CHIP_OPTIONS ||
      options.some(
        (option) => visibleLength(option) > ASK_USER_MAX_CHIP_OPTION_LENGTH,
      ))
    ? ASK_USER_OPTION_LAYOUT.list
    : ASK_USER_OPTION_LAYOUT.chips;
};

export const answersInOwnWords = (
  question: AskUserQuestion,
  draft: AskUserDraft,
): boolean => askUserOptionsOf(question).length === 0 || draft.ownWords;

/** Pick an option: the one answer, or one more (or one fewer) of several. */
export const pickAskUserOption = (
  question: AskUserQuestion,
  draft: AskUserDraft,
  option: string,
): AskUserDraft => {
  const selection = askUserSelectionOf(question);
  switch (selection) {
    case ASK_USER_SELECTION.single:
      return { ...draft, picked: [option] };
    case ASK_USER_SELECTION.multiple:
      return {
        ...draft,
        picked: draft.picked.includes(option)
          ? draft.picked.filter((picked) => picked !== option)
          : [...draft.picked, option],
      };
    default:
      selection satisfies never;
      return panic(`Unknown ask-user selection: ${String(selection)}`);
  }
};

export const pickAllAskUserOptions = (
  question: AskUserQuestion,
  draft: AskUserDraft,
): AskUserDraft => ({ ...draft, picked: [...askUserOptionsOf(question)] });

/**
 * The answer a draft gives, or `null` while it gives none. Ticked options
 * are listed in the order the question offered them.
 */
export const askUserAnswerOf = (
  question: AskUserQuestion,
  draft: AskUserDraft,
): AskUserAnswer | null => {
  if (answersInOwnWords(question, draft)) {
    return draft.text.trim() === ""
      ? null
      : { question: question.question, answer: draft.text };
  }
  const selection = askUserSelectionOf(question);
  switch (selection) {
    case ASK_USER_SELECTION.single: {
      const answer = draft.picked.at(0);
      return answer === undefined
        ? null
        : { question: question.question, answer };
    }
    case ASK_USER_SELECTION.multiple: {
      const selected = askUserOptionsOf(question).filter((option) =>
        draft.picked.includes(option),
      );
      return selected.length === 0
        ? null
        : { question: question.question, selected };
    }
    default:
      selection satisfies never;
      return panic(`Unknown ask-user selection: ${String(selection)}`);
  }
};

export const askUserDraftOf = (
  drafts: Readonly<Record<number, AskUserDraft>>,
  index: number,
): AskUserDraft =>
  Object.hasOwn(drafts, index)
    ? (drafts[index] ?? EMPTY_ASK_USER_DRAFT)
    : EMPTY_ASK_USER_DRAFT;

/**
 * The answers the drafts give, one per question, or `null` until every
 * question has one the server accepts.
 */
export const askUserAnswersOf = (
  questions: readonly AskUserQuestion[],
  drafts: Readonly<Record<number, AskUserDraft>>,
): AskUserAnswer[] | null => {
  const answers: AskUserAnswer[] = [];
  for (const [index, question] of questions.entries()) {
    const answer = askUserAnswerOf(question, askUserDraftOf(drafts, index));
    if (answer === null) {
      return null;
    }
    answers.push(answer);
  }
  return askUserAnswersRefusal(questions, answers) === null ? answers : null;
};

/** A draft holding `answer`; a blank one is the empty draft. */
const draftOfAnswer = (
  question: AskUserQuestion,
  answer: string,
): AskUserDraft => {
  if (askUserOptionsOf(question).includes(answer)) {
    return { ...EMPTY_ASK_USER_DRAFT, picked: [answer] };
  }
  if (answer === "") {
    return EMPTY_ASK_USER_DRAFT;
  }
  return {
    ...EMPTY_ASK_USER_DRAFT,
    text: answer,
    ownWords: askUserOptionsOf(question).length > 0,
  };
};

/** The drafts a card opens with: each question's default, where it has one. */
export const initialAskUserDrafts = (
  questions: readonly AskUserQuestion[],
): Record<number, AskUserDraft> =>
  Object.fromEntries(
    questions.flatMap((question, index) =>
      question.default === undefined || question.default === ""
        ? []
        : [[index, draftOfAnswer(question, question.default)]],
    ),
  );

/**
 * The drafts "Edit answers" opens with: the stored answers again, the user's
 * own words in the text input, and a question without an answer at its
 * default.
 */
export const askUserDraftsFromAnswers = (
  questions: readonly AskUserQuestion[],
  answers: readonly AskUserAnswer[],
): Record<number, AskUserDraft> => {
  const defaults = initialAskUserDrafts(questions);
  return Object.fromEntries(
    questions.map((question, index) => {
      const answer = answers.at(index);
      if (answer === undefined) {
        return [index, askUserDraftOf(defaults, index)];
      }
      return [
        index,
        "selected" in answer
          ? { ...EMPTY_ASK_USER_DRAFT, picked: answer.selected }
          : draftOfAnswer(question, answer.answer),
      ];
    }),
  );
};
