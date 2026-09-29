/**
 * What kind of reference a decision's `case_number` holds.
 *
 * `case_number` is the decision's primary citable reference. For most
 * sources that is the court's docket, but a source may cite its decisions
 * primarily by a reporter or neutral citation and carry the docket as an
 * additional identifier. The type is stored in `case_number_type`; ingestion
 * validates it here, and readers that receive the column untyped read it
 * back here.
 *
 * Absent at ingestion is a docket, as is every row written before the column
 * existed (its default). An explicit value outside the closed list is not
 * defaulted: it is refused at ingestion and fails a read.
 */
import { panic } from "better-result";

import {
  DECISION_IDENTIFIER_TYPES,
  DECISION_PRIMARY_REFERENCE_TYPES,
  type DecisionIdentifier,
  type DecisionPrimaryReferenceType,
} from "@stll/legal-ast/decision-identifier";

import {
  UNPERSISTABLE_DECISION_FIELDS,
  UnpersistableDecisionFieldError,
} from "@/api/lib/errors/tagged-errors";

export const DEFAULT_PRIMARY_REFERENCE_TYPE =
  DECISION_IDENTIFIER_TYPES.CASE_NUMBER;

const isPrimaryReferenceType = (
  value: unknown,
): value is DecisionPrimaryReferenceType =>
  DECISION_PRIMARY_REFERENCE_TYPES.some((type) => type === value);

/**
 * The type an ingestion result declares. Absent is a docket; anything else
 * outside the closed list is refused at the boundary rather than defaulted.
 */
export const parsePrimaryReferenceType = (
  value: unknown,
): DecisionPrimaryReferenceType => {
  if (value === undefined) {
    return DEFAULT_PRIMARY_REFERENCE_TYPE;
  }
  if (isPrimaryReferenceType(value)) {
    return value;
  }
  throw new UnpersistableDecisionFieldError({
    message: `Decision primary reference type is not one of ${DECISION_PRIMARY_REFERENCE_TYPES.join(", ")}`,
    field: UNPERSISTABLE_DECISION_FIELDS.PRIMARY_REFERENCE_TYPE,
  });
};

/**
 * `case_number_type` as a raw SQL row returns it. The column is NOT NULL and
 * checked, so any other value is a read of the wrong column.
 */
export const primaryReferenceTypeFromStored = (
  value: unknown,
): DecisionPrimaryReferenceType =>
  isPrimaryReferenceType(value)
    ? value
    : panic(
        `Stored decision primary reference type is invalid: ${String(value)}`,
      );

type PrimaryReference = {
  caseNumber: string;
  caseNumberType: DecisionPrimaryReferenceType;
};

/** The primary reference as the identifier it is. */
export const primaryDecisionIdentifier = ({
  caseNumber,
  caseNumberType,
}: PrimaryReference): DecisionIdentifier => ({
  type: caseNumberType,
  value: caseNumber,
});

/**
 * Whether the primary reference is a docket, and so what the decision's
 * legacy `citation_key` is drawn from. Any other primary has no such key:
 * a docket key built from a reporter citation would bridge citations to it
 * as though they named a docket.
 */
export const primaryReferenceIsDocket = (
  type: DecisionPrimaryReferenceType,
): boolean => type === DECISION_IDENTIFIER_TYPES.CASE_NUMBER;
