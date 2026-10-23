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
 * One person on the bench with every part the decision gives them: a
 * presiding judge who also reported the case is one face captioned twice,
 * not two faces.
 */
export type DecisionBenchSeat = {
  key: string;
  name: string;
  portrait: DecisionJudge["portrait"];
  roles: readonly DecisionJudgeRole[];
};

/**
 * Who a row is. The roster row where the name matched one; otherwise the
 * name, since a decision that prints one name twice means one person.
 */
const personKey = (judge: DecisionJudge): string =>
  judge.judgeId === null ? `name:${judge.name}` : `judge:${judge.judgeId}`;

/**
 * The bench one person at a time, in reading order: each person where their
 * first role puts them, their roles in the contract's order, and the name
 * and portrait of the row read first.
 */
export const decisionBenchSeats = (
  judges: readonly DecisionJudge[],
): readonly DecisionBenchSeat[] => {
  const seats = new Map<string, DecisionBenchSeat>();
  for (const judge of orderDecisionJudges(judges)) {
    const key = personKey(judge);
    const seat = seats.get(key);
    seats.set(
      key,
      seat === undefined
        ? {
            key,
            name: judge.name,
            portrait: judge.portrait,
            roles: [judge.role],
          }
        : {
            ...seat,
            portrait: seat.portrait ?? judge.portrait,
            roles: seat.roles.includes(judge.role)
              ? seat.roles
              : [...seat.roles, judge.role],
          },
    );
  }
  return [...seats.values()];
};

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
