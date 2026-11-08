import { panic } from "better-result";

import {
  type ReadDecisionTextFields,
  TEXT_FIELD_TYPE,
  type TextField,
} from "@stll/api-contract/case-law-text-field";

import { truncateTextBytes } from "@/api/lib/search/response-text-bounds";

/** Display budget for unbounded publisher prose in the decision reader. */
export const DECISION_READER_PROSE_BYTES = 65_536;

export const projectReaderTextField = (field: TextField): TextField => {
  switch (field.type) {
    case TEXT_FIELD_TYPE.PRESENT:
      return {
        type: field.type,
        text: truncateTextBytes(field.text, DECISION_READER_PROSE_BYTES),
      };
    case TEXT_FIELD_TYPE.ABSENT:
      return field;
    default:
      field satisfies never;
      return panic(`Unhandled reader text field: ${String(field)}`);
  }
};

/**
 * The publisher text fields as the reader receives them. The reader draws
 * marks in these words, so whatever places a stored mark for an agent
 * reads the same projection.
 */
export const readerTextFields = (
  fields: ReadDecisionTextFields,
): ReadDecisionTextFields => ({
  abstract: projectReaderTextField(fields.abstract),
  headnote: projectReaderTextField(fields.headnote),
  legalSentence: projectReaderTextField(fields.legalSentence),
  summary: projectReaderTextField(fields.summary),
});
