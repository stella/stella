import { DECISION_JUDGE_ROLES } from "@stll/api-contract/case-law-judges";
import type { DecisionJudgeRole } from "@stll/api-contract/case-law-judges";

import type { ConstantMap } from "@/api/lib/constant-map";

/**
 * Where the roster row was read, for a later re-import to start from. Not
 * identity: a judge is matched on the name key, never on a link.
 */
export type JudgeExternalRefs = {
  sourceUrl?: string;
  wikidataId?: string;
  /**
   * The hash of the stored portrait's bytes, so a re-import transfers one
   * only where the court has changed it.
   */
  portraitSha256?: string;
};

/**
 * Where a stored portrait came from. One member, because one importer writes
 * portraits; a second source lands with the importer that writes it.
 */
export const PORTRAIT_SOURCES = ["court-official"] as const;

export type PortraitSource = (typeof PORTRAIT_SOURCES)[number];

export const PORTRAIT_SOURCE = {
  COURT_OFFICIAL: PORTRAIT_SOURCES[0],
} as const satisfies ConstantMap<PortraitSource>;

/** How a judge is named on a decision, by the contract's own member names. */
export const DECISION_JUDGE_ROLE = {
  RAPPORTEUR: DECISION_JUDGE_ROLES[0],
  PRESIDING: DECISION_JUDGE_ROLES[1],
  PANEL_MEMBER: DECISION_JUDGE_ROLES[2],
  DISSENTING: DECISION_JUDGE_ROLES[3],
  ADVOCATE_GENERAL: DECISION_JUDGE_ROLES[4],
} as const satisfies ConstantMap<DecisionJudgeRole>;

/**
 * Reading order of the roles, as the decision read sorts its bench in SQL.
 *
 * Each rank is the member's position in the contract's list, so the two
 * cannot disagree; the `satisfies` keeps the map total, so a role added to
 * the contract fails to compile here until it is placed.
 */
export const DECISION_JUDGE_ROLE_RANK = {
  rapporteur: DECISION_JUDGE_ROLES.indexOf("rapporteur"),
  presiding: DECISION_JUDGE_ROLES.indexOf("presiding"),
  "panel-member": DECISION_JUDGE_ROLES.indexOf("panel-member"),
  dissenting: DECISION_JUDGE_ROLES.indexOf("dissenting"),
  "advocate-general": DECISION_JUDGE_ROLES.indexOf("advocate-general"),
} satisfies Record<DecisionJudgeRole, number>;
