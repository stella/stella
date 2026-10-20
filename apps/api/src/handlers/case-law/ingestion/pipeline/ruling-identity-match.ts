import { eq, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import {
  rulingGroupKeys,
  rulingKeysOf,
} from "@stll/api-contract/decision-ruling-identity";
import type {
  RulingIdentityInput,
  RulingIdentityKeys,
} from "@stll/api-contract/decision-ruling-identity";

export const REPUBLISHED_RULING_OUTCOME = {
  LINKED: "linked",
  SEPARATE_PARTIAL: "separate_partial",
  SEPARATE_AMBIGUOUS: "separate_ambiguous",
} as const;

export const REPUBLISHED_RULING_PARTIAL_REASON = {
  DATE_ABSENT: "date_absent",
  TYPE_ABSENT: "type_absent",
  SIGNATURE_ABSENT: "signature_absent",
  DATE_DIFFERS: "date_differs",
  TYPE_DIFFERS: "type_differs",
} as const;

type RepublishedRulingPartialReason =
  (typeof REPUBLISHED_RULING_PARTIAL_REASON)[keyof typeof REPUBLISHED_RULING_PARTIAL_REASON];

export type RepublishedRulingMatch =
  | { type: typeof REPUBLISHED_RULING_OUTCOME.LINKED; decisionId: string }
  | {
      type: typeof REPUBLISHED_RULING_OUTCOME.SEPARATE_PARTIAL;
      reason: RepublishedRulingPartialReason;
    }
  | { type: typeof REPUBLISHED_RULING_OUTCOME.SEPARATE_AMBIGUOUS };

export type StoredRulingCandidate = {
  decisionId: string;
  identity: RulingIdentityInput;
};

const sameCourt = (
  left: RulingIdentityInput,
  right: RulingIdentityInput,
): boolean => {
  if (left.courtId && right.courtId) {
    return left.courtId === right.courtId;
  }
  const leftCourt = rulingKeysOf({ ...left, courtId: undefined }).court;
  const rightCourt = rulingKeysOf({ ...right, courtId: undefined }).court;
  return (
    leftCourt.kind === "name" &&
    rightCourt.kind === "name" &&
    leftCourt.key === rightCourt.key
  );
};

type RepublishedRulingCourtColumns = {
  court: SQL | PgColumn;
  courtId: SQL | PgColumn;
};

type RepublishedRulingObservedCourt = {
  court: string | SQL | PgColumn | null | undefined;
  courtId: string | SQL | PgColumn | null | undefined;
};

const courtNameKeySql = (court: SQL | PgColumn): SQL => sql`
  lower(regexp_replace(normalize(${court}, NFKD), '[[:space:]]+', '', 'g'))
`;

/** The database candidate form of the matcher's court-identity rule. */
export const republishedRulingCourtPredicate = (
  observed: RepublishedRulingObservedCourt,
  columns: RepublishedRulingCourtColumns,
): SQL => {
  const nameMatches = eq(
    courtNameKeySql(columns.court),
    courtNameKeySql(
      typeof observed.court === "string"
        ? sql`${observed.court}`
        : (observed.court ?? sql``),
    ),
  );
  if (observed.courtId === undefined || observed.courtId === null) {
    return nameMatches;
  }
  return sql`(
    (${columns.courtId} IS NOT NULL AND ${observed.courtId} IS NOT NULL
      AND ${columns.courtId} = ${observed.courtId})
    OR ((${columns.courtId} IS NULL OR ${observed.courtId} IS NULL)
      AND ${nameMatches})
  )`;
};

const sharesDocket = (
  left: RulingIdentityKeys,
  right: RulingIdentityKeys,
): boolean =>
  left.dockets.some(({ key }) =>
    right.dockets.some((candidate) => candidate.key === key),
  );

/**
 * Classify a cross-source ruling candidate set. Only a complete five-part
 * identity can link; missing or contradictory parts remain separate and are
 * reported rather than guessed.
 */
export const matchRepublishedRuling = (
  incomingInput: RulingIdentityInput,
  stored: readonly StoredRulingCandidate[],
): RepublishedRulingMatch => {
  const incoming = rulingKeysOf(incomingInput);
  if (incoming.date.kind === "absent") {
    return {
      type: REPUBLISHED_RULING_OUTCOME.SEPARATE_PARTIAL,
      reason: REPUBLISHED_RULING_PARTIAL_REASON.DATE_ABSENT,
    };
  }
  if (incoming.decisionKind.kind === "absent") {
    return {
      type: REPUBLISHED_RULING_OUTCOME.SEPARATE_PARTIAL,
      reason: REPUBLISHED_RULING_PARTIAL_REASON.TYPE_ABSENT,
    };
  }
  if (incoming.dockets.length === 0) {
    return {
      type: REPUBLISHED_RULING_OUTCOME.SEPARATE_PARTIAL,
      reason: REPUBLISHED_RULING_PARTIAL_REASON.SIGNATURE_ABSENT,
    };
  }

  const incomingDecisionKind = incoming.decisionKind.key;
  const incomingDate = incoming.date.value;
  const comparable = stored.map(({ decisionId, identity }) => ({
    decisionId,
    identity,
    keys: rulingKeysOf(identity),
  }));
  const exact = comparable.filter(({ identity, keys }) => {
    if (keys.decisionKind.kind === "absent") {
      return false;
    }
    return (
      keys.decisionKind.key === incomingDecisionKind &&
      sameCourt(identity, incomingInput) &&
      rulingGroupKeys(keys).some((group) =>
        rulingGroupKeys(incoming).includes(group),
      )
    );
  });
  const exactMatch = exact.at(0);
  if (exact.length === 1 && exactMatch !== undefined) {
    return {
      type: REPUBLISHED_RULING_OUTCOME.LINKED,
      decisionId: exactMatch.decisionId,
    };
  }
  if (exact.length > 1) {
    return { type: REPUBLISHED_RULING_OUTCOME.SEPARATE_AMBIGUOUS };
  }

  const sameSignature = comparable.filter(
    ({ keys, identity }) =>
      keys.country === incoming.country &&
      sameCourt(identity, incomingInput) &&
      sharesDocket(keys, incoming),
  );
  if (
    sameSignature.some(
      ({ keys }) =>
        keys.date.kind === "stated" && keys.date.value !== incomingDate,
    )
  ) {
    return {
      type: REPUBLISHED_RULING_OUTCOME.SEPARATE_PARTIAL,
      reason: REPUBLISHED_RULING_PARTIAL_REASON.DATE_DIFFERS,
    };
  }
  return {
    type: REPUBLISHED_RULING_OUTCOME.SEPARATE_PARTIAL,
    reason: REPUBLISHED_RULING_PARTIAL_REASON.TYPE_DIFFERS,
  };
};
