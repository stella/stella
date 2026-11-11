// The verification graph of a list: the documents verified against it
// (statements), their claims, the list's facts and the documents those facts
// come from (sources), with an edge for every link the stored blocks already
// hold. Nothing here is stored: the graph is a reading of the runs, claims,
// review events and list facts, so it cannot drift from them.
//
// Pure on purpose: the read gathers the rows, and this decides what the graph
// says about them, so the rules below are tested without a database.

import { panic } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import type { FactDatePrecision } from "@/api/lib/lists/fact-details";
import type { LegalListSourceLocator } from "@/api/lib/lists/types";
import type {
  ClaimRef,
  ClaimReviewStatus,
  ClaimState,
  RecordConflict,
} from "@/api/lib/lists/verification/contract";
import type {
  ClaimQualifier,
  FactStanding,
} from "@/api/lib/lists/verification/qualifiers";

type RunId = SafeId<"legalListVerificationRun">;
type ClaimId = SafeId<"legalListClaim">;
type FactId = SafeId<"entity">;
type DocumentId = SafeId<"entity">;

/** One document verified against the list: its latest finished run. */
export type GraphStatementInput = {
  runId: RunId;
  entityId: DocumentId;
  fileFieldId: SafeId<"field">;
  documentName: string;
  finishedAt: string | null;
  /** Claims the run holds, including any a page leaves out. */
  claimCount: number;
};

/** A claim as its reviewers see it now: its current grade (a re-check
 *  replaces the run's) after their own decisions. */
export type GraphClaimInput = {
  id: ClaimId;
  runId: RunId;
  position: number;
  text: string;
  state: ClaimState;
  refs: readonly ClaimRef[];
  recordConflict: RecordConflict | null;
  /** The record a reviewer chose to govern the conflict, if any. */
  governingFactId: FactId | null;
  reviewStatus: ClaimReviewStatus | null;
  qualifiers: readonly ClaimQualifier["kind"][];
};

type GraphSourceInput = {
  documentId: DocumentId;
  documentName: string;
  locator: LegalListSourceLocator;
};

export type GraphFactInput = {
  factEntityId: FactId;
  text: string;
  occurredOn: string | null;
  occurredOnPrecision: FactDatePrecision | null;
  standing: FactStanding;
  /** The fact's place on the list; null once it is off the list and only a
   *  run still pins it. */
  listOrdinal: number | null;
  sources: readonly GraphSourceInput[];
};

export type GraphInput = {
  statements: readonly GraphStatementInput[];
  claims: readonly GraphClaimInput[];
  facts: readonly GraphFactInput[];
};

/**
 * A claim's link to a fact. `cites` is a fact its grade cites (the relation
 * the grader gave it); `record-conflict` is one of the two records a
 * withheld verdict sits between, each drawn, never one for the pair. A fact
 * both cited and in conflict is one edge, the conflict.
 */
type GraphCitation =
  | {
      type: "cites";
      claimId: ClaimId;
      factId: FactId;
      rel: ClaimRef["rel"];
    }
  | {
      type: "record-conflict";
      claimId: ClaimId;
      factId: FactId;
      /** The verdict the claim takes if this record governs. */
      stateIfGoverning: RecordConflict["governingStates"][number];
      /** Whether a reviewer chose this record to govern. */
      governs: boolean;
    };

/** Where a fact comes from: a document, at a place in it. */
type GraphProvenance = {
  factId: FactId;
  sourceId: DocumentId;
  locator: LegalListSourceLocator;
};

/** Code-unit order: ids and names compare the same on every server. */
const compareText = (a: string, b: string) => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

const statementKey = (statement: GraphStatementInput) =>
  `${statement.entityId}/${statement.fileFieldId}/${statement.runId}`;

/** A fact on the list sorts by its place there; one off the list after
 *  them, by id. */
const compareFacts = (a: GraphFactInput, b: GraphFactInput) => {
  if (a.listOrdinal !== null && b.listOrdinal !== null) {
    return (
      a.listOrdinal - b.listOrdinal ||
      compareText(a.factEntityId, b.factEntityId)
    );
  }
  if (a.listOrdinal !== null) {
    return -1;
  }
  if (b.listOrdinal !== null) {
    return 1;
  }
  return compareText(a.factEntityId, b.factEntityId);
};

/** The links of one claim, one per fact: its two conflicting records first,
 *  then the facts its grade cites, in the order the grade gives them. */
const citationsOf = (claim: GraphClaimInput): GraphCitation[] => {
  const conflict = claim.recordConflict;
  const inConflict = new Set<FactId>(conflict?.factEntityIds);
  const conflictEdges: GraphCitation[] =
    conflict === null
      ? []
      : conflict.factEntityIds.map((factId, side) => ({
          type: "record-conflict",
          claimId: claim.id,
          factId,
          stateIfGoverning:
            conflict.governingStates.at(side) ??
            panic("A record conflict has fewer verdicts than records"),
          governs: claim.governingFactId === factId,
        }));
  const seen = new Set<FactId>(inConflict);
  const cited: GraphCitation[] = [];
  for (const ref of claim.refs) {
    if (seen.has(ref.factEntityId)) {
      continue;
    }
    seen.add(ref.factEntityId);
    cited.push({
      type: "cites",
      claimId: claim.id,
      factId: ref.factEntityId,
      rel: ref.rel,
    });
  }
  return [...conflictEdges, ...cited];
};

/**
 * The graph of one page of statements. Deterministic: the same rows give the
 * same graph whatever order they arrive in. Statements sort by document,
 * claims by statement then reading order, facts by their place on the list,
 * sources by name, and every edge by its ends.
 */
export const buildVerificationGraph = ({
  statements,
  claims,
  facts,
}: GraphInput) => {
  const orderedStatements = statements.toSorted((a, b) =>
    compareText(statementKey(a), statementKey(b)),
  );
  const statementOrder = new Map(
    orderedStatements.map((statement, index) => [statement.runId, index]),
  );
  const statementIndexOf = (claim: GraphClaimInput) =>
    statementOrder.get(claim.runId) ??
    panic("A graph claim belongs to no statement of the page");
  const orderedClaims = claims
    .map((claim) => ({ claim, statement: statementIndexOf(claim) }))
    .toSorted(
      (a, b) =>
        a.statement - b.statement || a.claim.position - b.claim.position,
    )
    .map(({ claim }) => claim);
  const orderedFacts = facts.toSorted(compareFacts);
  const factOrder = new Map(
    orderedFacts.map((fact, index) => [fact.factEntityId, index]),
  );
  const claimOrder = new Map(
    orderedClaims.map((claim, index) => [claim.id, index]),
  );

  const citations = orderedClaims
    .flatMap(citationsOf)
    .map((citation) => {
      if (!factOrder.has(citation.factId)) {
        panic("A claim links a fact the graph was not given");
      }
      return citation;
    })
    .toSorted(
      (a, b) =>
        (claimOrder.get(a.claimId) ?? 0) - (claimOrder.get(b.claimId) ?? 0) ||
        (factOrder.get(a.factId) ?? 0) - (factOrder.get(b.factId) ?? 0),
    );

  const sourceNames = new Map<DocumentId, string>();
  for (const fact of orderedFacts) {
    for (const source of fact.sources) {
      if (!sourceNames.has(source.documentId)) {
        sourceNames.set(source.documentId, source.documentName);
      }
    }
  }
  const sources = [...sourceNames]
    .map(([id, name]) => ({ id, name }))
    .toSorted((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id));

  const provenance: GraphProvenance[] = orderedFacts.flatMap((fact) =>
    fact.sources.map((source) => ({
      factId: fact.factEntityId,
      sourceId: source.documentId,
      locator: source.locator,
    })),
  );

  return {
    statements: orderedStatements.map((statement) => ({
      id: statement.runId,
      entityId: statement.entityId,
      fileFieldId: statement.fileFieldId,
      name: statement.documentName,
      finishedAt: statement.finishedAt,
      claimCount: statement.claimCount,
    })),
    claims: orderedClaims.map((claim) => ({
      id: claim.id,
      statementId: claim.runId,
      position: claim.position,
      text: claim.text,
      state: claim.state,
      reviewStatus: claim.reviewStatus,
      qualifiers: claim.qualifiers,
    })),
    facts: orderedFacts.map((fact) => ({
      id: fact.factEntityId,
      text: fact.text,
      occurredOn: fact.occurredOn,
      occurredOnPrecision: fact.occurredOnPrecision,
      tier: fact.standing.tier,
      held: fact.standing.scoring === "held",
      listed: fact.listOrdinal !== null,
    })),
    sources,
    citations,
    provenance,
  };
};
