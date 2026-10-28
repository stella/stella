import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { Column } from "drizzle-orm";
import * as v from "valibot";

import { caseLawTextStatusSchema } from "@stll/api-contract/case-law-fulltext-state";
import { DECISION_TEXT_AVAILABILITY } from "@stll/api-contract/case-law-text-field";
import {
  CASE_LAW_TEXT_STATUS,
  type CaseLawTextStatus,
} from "@stll/api-contract/case-law-text-status";

const nullableTextStatusSchema = v.nullable(caseLawTextStatusSchema);

/** Only an untouched legacy row may carry null; malformed states are defects. */
export const readDecisionTextStateStatus = (value: unknown) => {
  const parsed = v.safeParse(nullableTextStatusSchema, value);
  if (!parsed.success) {
    return panic("Invalid public decision text state status");
  }
  return parsed.output;
};

/** Public readers expose the status, never retry details or publisher evidence. */
export const decisionTextStateStatusColumn = ({
  textState,
}: {
  textState: Column;
}) =>
  sql<unknown>`${textState} ->> 'status'`.mapWith(readDecisionTextStateStatus);

export const decisionTextAvailability = (
  textState: CaseLawTextStatus | null,
  legacyHasDocument: boolean,
) => {
  switch (textState) {
    case CASE_LAW_TEXT_STATUS.STORED:
      return DECISION_TEXT_AVAILABILITY.AVAILABLE;
    case CASE_LAW_TEXT_STATUS.PUBLISHER_HAS_NO_TEXT:
    case CASE_LAW_TEXT_STATUS.FETCH_PENDING:
    case CASE_LAW_TEXT_STATUS.FETCH_FAILED:
    case CASE_LAW_TEXT_STATUS.METADATA_ONLY_BY_SOURCE:
      return DECISION_TEXT_AVAILABILITY.METADATA_ONLY;
    case null:
      return legacyHasDocument
        ? DECISION_TEXT_AVAILABILITY.AVAILABLE
        : DECISION_TEXT_AVAILABILITY.METADATA_ONLY;
    default:
      textState satisfies never;
      return panic(`Unhandled decision text state: ${String(textState)}`);
  }
};
