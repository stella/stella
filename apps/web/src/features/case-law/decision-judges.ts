import { DECISION_JUDGE_ROLES } from "@stll/api-contract/case-law-judges";
import type { DecisionJudgeRole } from "@stll/api-contract/case-law-judges";

import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import type { TranslationKey } from "@/i18n/types";

/**
 * A judge the court printed on a decision, as the read answers it. The name
 * is always there; the roster row and its portrait only where the printed
 * name matched one, so a bench still draws when the roster does not know a
 * name yet.
 */
export type DecisionJudge = PublicCaseLawDecision["judges"][number];

/**
 * The order the bench is read in, independent of the order the read returned
 * it. Each rank is the role's position in the contract's list, which is the
 * same list the API sorts its read by, so the two orders cannot disagree.
 */
const ROLE_ORDER = {
  rapporteur: DECISION_JUDGE_ROLES.indexOf("rapporteur"),
  presiding: DECISION_JUDGE_ROLES.indexOf("presiding"),
  "panel-member": DECISION_JUDGE_ROLES.indexOf("panel-member"),
  dissenting: DECISION_JUDGE_ROLES.indexOf("dissenting"),
  "advocate-general": DECISION_JUDGE_ROLES.indexOf("advocate-general"),
} satisfies Record<DecisionJudgeRole, number>;

/** How each role is captioned under a judge. */
export const DECISION_JUDGE_ROLE_LABELS = {
  "advocate-general": "caseLaw.viewer.judgeRole.advocateGeneral",
  dissenting: "caseLaw.viewer.judgeRole.dissenting",
  "panel-member": "caseLaw.viewer.judgeRole.panelMember",
  presiding: "caseLaw.viewer.judgeRole.presiding",
  rapporteur: "caseLaw.viewer.judgeRole.rapporteur",
} as const satisfies Record<DecisionJudgeRole, TranslationKey>;

/**
 * The bench in reading order. `sort` is stable, so judges keep the order the
 * court printed them in within their role.
 */
export const orderDecisionJudges = (
  judges: readonly DecisionJudge[],
): readonly DecisionJudge[] =>
  [...judges].toSorted((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);

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
