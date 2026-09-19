/**
 * The parts a judge is named for on a decision.
 *
 * The list lives in the contract because two runtimes decide per role: the
 * API, which types the stored column and the order the read sorts a bench in,
 * and the web reader, which captions each judge. A second copy on either side
 * would let a role the ingestion writes arrive at a reader that cannot label
 * it, so both import this one.
 *
 * The order is the display order a bench is read in, rapporteur first: a role
 * added here states where it sorts rather than landing wherever its name
 * happens to fall. Every companion map keyed by `DecisionJudgeRole`
 * (`satisfies Record<DecisionJudgeRole, …>`) then fails to compile until the
 * new member has a declared rank, caption and parser.
 */
export const DECISION_JUDGE_ROLES = [
  "rapporteur",
  "presiding",
  "panel-member",
  "dissenting",
] as const;

export type DecisionJudgeRole = (typeof DECISION_JUDGE_ROLES)[number];
