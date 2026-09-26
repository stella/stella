/**
 * What makes two decision rows language versions of one decision.
 *
 * `ecli-or-docket` groups by the ECLI, or else by the source's docket: the
 * same judgment published in two languages shares both. That fails where
 * the primary reference is not a docket, or may change: a decision first
 * listed under its docket and later under its reporter citation would move
 * group, and two decisions sharing a reference would merge. There the
 * publisher's own document identity is the group (`source-document`), and
 * such a jurisdiction's rows must carry one.
 */
import { panic } from "better-result";

import {
  type CaseLawJurisdiction,
  isCaseLawJurisdiction,
} from "@stll/api-contract/case-law-jurisdictions";

import {
  UNPERSISTABLE_DECISION_FIELDS,
  UnpersistableDecisionFieldError,
} from "@/api/lib/errors/tagged-errors";

export const DECISION_LANGUAGE_IDENTITY = {
  ECLI_OR_DOCKET: "ecli-or-docket",
  SOURCE_DOCUMENT: "source-document",
} as const;

type DecisionLanguageIdentity =
  (typeof DECISION_LANGUAGE_IDENTITY)[keyof typeof DECISION_LANGUAGE_IDENTITY];

const DECISION_LANGUAGE_IDENTITY_POLICY = {
  AUT: DECISION_LANGUAGE_IDENTITY.ECLI_OR_DOCKET,
  CZE: DECISION_LANGUAGE_IDENTITY.ECLI_OR_DOCKET,
  EU: DECISION_LANGUAGE_IDENTITY.ECLI_OR_DOCKET,
  HUN: DECISION_LANGUAGE_IDENTITY.ECLI_OR_DOCKET,
  POL: DECISION_LANGUAGE_IDENTITY.ECLI_OR_DOCKET,
  SVK: DECISION_LANGUAGE_IDENTITY.ECLI_OR_DOCKET,
  USA: DECISION_LANGUAGE_IDENTITY.SOURCE_DOCUMENT,
} as const satisfies Record<CaseLawJurisdiction, DecisionLanguageIdentity>;

/**
 * A stored country no jurisdiction declares keeps the grouping every row
 * had before the policy existed, as `decisionDateMinYear` keeps its floor.
 */
export const decisionLanguageIdentityOf = (
  country: string,
): DecisionLanguageIdentity =>
  isCaseLawJurisdiction(country)
    ? DECISION_LANGUAGE_IDENTITY_POLICY[country]
    : DECISION_LANGUAGE_IDENTITY.ECLI_OR_DOCKET;

/**
 * Refuse a result its jurisdiction cannot identify: one keyed by source
 * document without a document identity, which would otherwise fall back to
 * matching rows by their reference.
 */
export const assertDecisionLanguageIdentity = ({
  country,
  sourceDocumentId,
}: {
  country: string;
  sourceDocumentId: string | undefined;
}): void => {
  if (
    decisionLanguageIdentityOf(country) ===
      DECISION_LANGUAGE_IDENTITY.SOURCE_DOCUMENT &&
    sourceDocumentId === undefined
  ) {
    throw new UnpersistableDecisionFieldError({
      message: `Decisions of ${country} need a publisher document identity`,
      field: UNPERSISTABLE_DECISION_FIELDS.SOURCE_DOCUMENT_ID,
    });
  }
};

/**
 * Refuse a supplement where decisions are not grouped by docket: supplements
 * find their judgment by court, docket and language, which such a
 * jurisdiction does not treat as an identity.
 */
export const assertDocketKeyedSupplementAllowed = (country: string): void => {
  if (
    decisionLanguageIdentityOf(country) ===
    DECISION_LANGUAGE_IDENTITY.SOURCE_DOCUMENT
  ) {
    throw new UnpersistableDecisionFieldError({
      message: `Decisions of ${country} take no docket-keyed supplements`,
      field: UNPERSISTABLE_DECISION_FIELDS.SUPPLEMENT,
    });
  }
};

type DecisionLanguageGroupKeyOptions = {
  caseNumber: string;
  country: string;
  ecli: string | undefined;
  sourceDocumentId: string | undefined;
  sourceId: string;
};

export const decisionLanguageGroupKey = ({
  caseNumber,
  country,
  ecli,
  sourceDocumentId,
  sourceId,
}: DecisionLanguageGroupKeyOptions): string => {
  const identity = decisionLanguageIdentityOf(country);
  switch (identity) {
    case DECISION_LANGUAGE_IDENTITY.ECLI_OR_DOCKET:
      return ecli || `${sourceId}:${caseNumber}`;
    case DECISION_LANGUAGE_IDENTITY.SOURCE_DOCUMENT:
      return sourceDocumentId === undefined
        ? panic(`A ${country} decision reached the write without its identity`)
        : `${sourceId}:document:${sourceDocumentId}`;
    default: {
      identity satisfies never;
      return panic(`Unhandled language identity: ${String(identity)}`);
    }
  }
};
