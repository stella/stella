import { panic } from "better-result";
import * as v from "valibot";

import {
  type CourtCitationConstraint,
  type CourtCitationIndex,
  courtCitationIndex,
  ecliCourtCodeOf,
  readCourtCitation,
  storedCourtKeys,
} from "@stll/api-contract/court-citation-aliases";
import type { DecisionDocketGrammar } from "@stll/api-contract/decision-docket-grammar";
import {
  type DecisionIdentifierIntent,
  decisionReferenceContext,
  type DecisionReporterGrammar,
  docketSelectorAgreement,
  exactDecisionMatches,
  parseDecisionQuery,
} from "@stll/api-contract/decision-query-intent";
import {
  type LegalResolveResponse,
  legalResolveResponseSchema,
} from "@stll/api-contract/legal-resolve";

import type { DecisionIdentityRow } from "@/api/handlers/case-law/decisions/lookup-by-identity";

/**
 * A decision citation read into the constraints it carries, and the one
 * place a `resolved` answer is made.
 *
 * A citation states more than its docket: the country it was asked in, the
 * court written around the docket (`Obvodní soud pro Prahu 6`, `OS P6`,
 * `OSPH06`), the sheet. Each is a constraint on the decision, and a decision
 * that breaks any of them is a different decision, however the lookup
 * arrived at it. So the resolver never builds `resolved` itself: it asks
 * {@link admitResolvedDecision}, which checks every constraint against the
 * decision's own stored identity (country, docket, sheet, court name and
 * ECLI court code) and answers `not_found`/`not_at_this_court` (or
 * `ambiguous`) for a decision that fails one. The resolved type is branded,
 * so a resolved literal anywhere else does not compile.
 */

type ResolvedResponse = Extract<LegalResolveResponse, { status: "resolved" }>;
type ResolvedDecisionDocument = Extract<
  ResolvedResponse["document"],
  { kind: "decision" }
>;
type OtherCourtCandidate = NonNullable<
  ResolvedResponse["otherCourtCandidates"]
>[number];
type Candidate = Extract<
  LegalResolveResponse,
  { status: "ambiguous" }
>["candidates"][number];

/** The brand only this module holds, so no other module can forge one. */
const VERIFIED_AGAINST_CONSTRAINTS = Symbol("verifiedAgainstConstraints");

const verifiedResolutionSchema = v.pipe(
  legalResolveResponseSchema,
  v.brand(VERIFIED_AGAINST_CONSTRAINTS),
);

/** A resolved decision that met every constraint its citation carried. */
export type VerifiedResolvedDecision = ResolvedResponse &
  v.Brand<typeof VERIFIED_AGAINST_CONSTRAINTS>;

/** What the decision resolver answers: only a verified decision resolves. */
export type DecisionResolveResponse =
  | Exclude<LegalResolveResponse, { status: "resolved" }>
  | VerifiedResolvedDecision;

export type DecisionConstraints = {
  /** The stored country every decision must carry. */
  readonly country: string;
  /** The reference: docket family and selector, or ECLI. */
  readonly intent: DecisionIdentifierIntent;
  readonly reporters: DecisionReporterGrammar | null;
  /** Every court the citation's other words name; each must hold. */
  readonly courts: readonly CourtCitationConstraint[];
  readonly index: CourtCitationIndex;
};

type CitationReading = {
  intent: DecisionIdentifierIntent;
  /** The citation's words outside its reference. */
  courtText: string;
};

const LEADING_NUMERAL_RE = /^(?<numeral>\d{1,3}) (?<rest>\d.*)$/u;

/**
 * The reference and the words around it. A seat number written straight
 * before the docket (`Obvodní soud pro Prahu 6 8 C 123/2024`) also reads as a
 * spaced senate number (`6 8 C`); where the numeral completes a court the
 * words before it name, it is the court's, and the docket is the rest.
 */
export const readDecisionCitation = ({
  country,
  identifier,
  intent,
  grammar,
  reporters,
}: {
  country: string;
  identifier: string;
  intent: DecisionIdentifierIntent;
  grammar: DecisionDocketGrammar | null;
  reporters: DecisionReporterGrammar | null;
}): CitationReading => {
  const context = decisionReferenceContext(identifier, { grammar, reporters });
  const courtText =
    context === null ? "" : [context.before, context.after].join(" ").trim();
  const split =
    intent.kind === "docket" && context !== null
      ? LEADING_NUMERAL_RE.exec(intent.value)?.groups
      : undefined;
  const rest = split?.["rest"];
  const numeral = split?.["numeral"];
  if (context === null || rest === undefined || numeral === undefined) {
    return { intent, courtText };
  }
  const shorter = parseDecisionQuery(rest, { grammar, reporters });
  if (shorter.type !== "identifier" || shorter.kind !== "docket") {
    return { intent, courtText };
  }
  const index = courtCitationIndex(country);
  const withNumeral = [`${context.before} ${numeral}`.trim(), context.after]
    .join(" ")
    .trim();
  const read = readCourtCitation(index, courtText);
  const reread = readCourtCitation(index, withNumeral);
  const names = (constraints: readonly CourtCitationConstraint[]) =>
    constraints.some(({ type }) => type === "court") &&
    constraints.every(({ type }) => type !== "unrecognized");
  return !names(read) && names(reread)
    ? {
        intent: { ...shorter, embeddedIn: identifier },
        courtText: withNumeral,
      }
    : { intent, courtText };
};

/**
 * The constraints a citation carries, read against the directory and the
 * courts the lookup's holders are stored under.
 */
export const decisionConstraints = ({
  country,
  intent,
  reporters,
  courtText,
  holders,
}: {
  country: string;
  intent: DecisionIdentifierIntent;
  reporters: DecisionReporterGrammar | null;
  courtText: string;
  holders: readonly DecisionIdentityRow[];
}): DecisionConstraints => {
  const index = courtCitationIndex(
    country,
    holders.map(({ court }) => court),
  );
  return {
    country,
    intent,
    reporters,
    courts: courtText === "" ? [] : readCourtCitation(index, courtText),
    index,
  };
};

/** Whether the citation names a court at all. */
export const namesCourt = (constraints: DecisionConstraints): boolean =>
  constraints.courts.length > 0;

/** Whether a court the citation names is one no alias reads. */
export const namesUnrecognizedCourt = (
  constraints: DecisionConstraints,
): boolean => constraints.courts.some(({ type }) => type === "unrecognized");

/** Whether a court alias the citation writes answers to several courts. */
export const namesAmbiguousCourt = (
  constraints: DecisionConstraints,
): boolean =>
  constraints.courts.some(
    (constraint) => constraint.type === "court" && constraint.courts.length > 1,
  );

const courtConstraintHolds = (
  constraint: CourtCitationConstraint,
  keys: readonly string[],
  code: string | undefined,
): boolean => {
  switch (constraint.type) {
    case "court":
      return (
        keys.length > 0 && keys.every((key) => constraint.courts.includes(key))
      );
    case "ecli-code":
      return code !== undefined && code === constraint.code;
    case "unrecognized":
      return false;
    default:
      constraint satisfies never;
      return panic("Unhandled court constraint");
  }
};

/** Whether the decision is at every court the citation names. */
export const atNamedCourt = (
  constraints: DecisionConstraints,
  row: DecisionIdentityRow,
): boolean => {
  const keys = storedCourtKeys(constraints.index, row);
  const code = ecliCourtCodeOf(constraints.country, row.ecli);
  return constraints.courts.every((constraint) =>
    courtConstraintHolds(constraint, keys, code),
  );
};

export type ConstraintViolation = "country" | "docket" | "sheet" | "court";

/** The first constraint the decision breaks, or null when it meets all. */
export const constraintViolation = (
  constraints: DecisionConstraints,
  row: DecisionIdentityRow,
): ConstraintViolation | null => {
  if (row.country !== constraints.country) {
    return "country";
  }
  if (
    exactDecisionMatches(constraints.intent, [row], {
      reporters: constraints.reporters,
    }).length !== 1
  ) {
    return "docket";
  }
  if (docketSelectorAgreement(constraints.intent, row) === "contradicts") {
    return "sheet";
  }
  return atNamedCourt(constraints, row) ? null : "court";
};

type AdmitOptions = {
  constraints: DecisionConstraints;
  row: DecisionIdentityRow;
  /** Builds the decision's document; called only for a verified decision. */
  document: (row: DecisionIdentityRow) => Promise<ResolvedDecisionDocument>;
  candidate: (row: DecisionIdentityRow) => Candidate;
  otherCourtCandidate: (row: DecisionIdentityRow) => OtherCourtCandidate;
  otherCourtCandidates: readonly OtherCourtCandidate[];
};

const withCandidates = <T extends object>(
  response: T,
  otherCourtCandidates: readonly OtherCourtCandidate[],
): T & { otherCourtCandidates?: OtherCourtCandidate[] } =>
  otherCourtCandidates.length === 0
    ? response
    : { ...response, otherCourtCandidates: [...otherCourtCandidates] };

/**
 * The only constructor of a resolved decision. The decision must meet every
 * constraint the citation carried, and the document built for it must be
 * that decision's; otherwise the answer is what the constraints allow: a
 * decision at another court is an other-court candidate, an ambiguous court
 * alias leaves the decision a candidate to choose, and a decision of another
 * docket or country is not the one asked for.
 */
export const admitResolvedDecision = async ({
  constraints,
  row,
  document,
  candidate,
  otherCourtCandidate,
  otherCourtCandidates,
}: AdmitOptions): Promise<DecisionResolveResponse> => {
  const violation = constraintViolation(constraints, row);
  const others = otherCourtCandidates.filter(
    ({ decisionId }) => decisionId !== row.id,
  );
  switch (violation) {
    case "country":
    case "docket":
    case "sheet":
      return withCandidates(
        { status: "not_found", reason: "no_exact_identity" },
        others,
      );
    case "court":
      return {
        status: "not_found",
        reason: namesUnrecognizedCourt(constraints)
          ? "court_unrecognized"
          : "not_at_this_court",
        otherCourtCandidates: [otherCourtCandidate(row), ...others],
      };
    case null:
      break;
    default:
      violation satisfies never;
      return panic("Unhandled constraint violation");
  }
  if (namesAmbiguousCourt(constraints)) {
    return withCandidates(
      { status: "ambiguous", candidates: [candidate(row)] },
      others,
    );
  }
  const built = await document(row);
  if (built.decisionId !== row.id || built.court !== row.court) {
    return withCandidates(
      { status: "not_found", reason: "no_exact_identity" },
      others,
    );
  }
  const resolved: ResolvedResponse = withCandidates(
    { status: "resolved", document: built },
    others,
  );
  // The one place the brand is given: every constraint was checked above,
  // and the answer is held to the wire schema on its way out.
  const verified = v.parse(verifiedResolutionSchema, resolved);
  return verified.status === "resolved"
    ? verified
    : panic("A verified resolution changed its status");
};
