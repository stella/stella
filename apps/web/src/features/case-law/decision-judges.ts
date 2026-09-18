import { DECISION_JUDGE_ROLES } from "@stll/api-contract/case-law-judges";
import type { DecisionJudgeRole } from "@stll/api-contract/case-law-judges";

import type { TranslationKey } from "@/i18n/types";

/**
 * A judge the court printed on a decision. The name is always there; the
 * roster row and its portrait only where the printed name matched one, so a
 * bench still draws when the roster does not know a name yet.
 *
 * The shape is stated here because the contract carries the roles, not the
 * read's row. The read's array is assigned to this type at every surface that
 * draws a bench, so a field the API drops fails to compile here instead of
 * rendering blank.
 */
export type DecisionJudge = {
  judgeId: string | null;
  name: string;
  portrait: { attribution: string; url: string } | null;
  role: DecisionJudgeRole;
};

/**
 * The order the bench is read in, independent of the order the read returned
 * it. Each rank is the role's position in the contract's list, which is the
 * same list the API sorts its read by, so the two orders cannot disagree.
 */
const ROLE_ORDER = {
  rapporteur: DECISION_JUDGE_ROLES.indexOf("rapporteur"),
  dissenting: DECISION_JUDGE_ROLES.indexOf("dissenting"),
} satisfies Record<DecisionJudgeRole, number>;

/** How each role is captioned under a judge. */
export const DECISION_JUDGE_ROLE_LABELS = {
  dissenting: "caseLaw.viewer.judgeRole.dissenting",
  rapporteur: "caseLaw.viewer.judgeRole.rapporteur",
} as const satisfies Record<DecisionJudgeRole, TranslationKey>;

/**
 * The bench in reading order. `sort` is stable, so judges keep the order the
 * court printed them in within their role.
 */
export const orderDecisionJudges = (
  judges: readonly DecisionJudge[],
): readonly DecisionJudge[] =>
  [...judges].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);

/** Who wrote separately, for the byline above their opinion. */
export const dissentingJudges = (
  judges: readonly DecisionJudge[],
): readonly DecisionJudge[] =>
  judges.filter((judge) => judge.role === "dissenting");

/**
 * A key that separates two judges of the same decision: the roster may not
 * know either of them, and the read keys a row by its role and name.
 */
export const decisionJudgeKey = (judge: DecisionJudge): string =>
  `${judge.role}:${judge.name}`;

/** The distinct sources credited for the portraits actually drawn. */
export const portraitAttributions = (
  judges: readonly DecisionJudge[],
): readonly string[] => [
  ...new Set(
    judges.flatMap((judge) =>
      judge.portrait === null ? [] : [judge.portrait.attribution],
    ),
  ),
];
