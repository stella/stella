import {
  ASK_USER_SELECTION,
  type AskUserQuestion,
  askUserSelectionOf,
} from "@stll/api-contract/chat-ask-user";
import { askUserOptionsOf } from "@stll/api-contract/chat-ask-user-draft";

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
