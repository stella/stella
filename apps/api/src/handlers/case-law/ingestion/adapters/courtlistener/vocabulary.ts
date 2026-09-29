import type { DecisionJudgeRole } from "@stll/api-contract/case-law-judges";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

/**
 * What an opinion row's `type` says about the decision, before its text is
 * read. `010combined` proves neither class: a combined row holds whatever the
 * publisher could not split.
 */
type OpinionTypeClassSignal = "opinion" | "order" | "none";

type OpinionTypeDeclaration = {
  /** The documented numeric prefix, which orders rows within a cluster. */
  readonly rank: number;
  /**
   * The role its author and joiners sit in. Only an explicit dissent is
   * `dissenting`; a concurrence, in part or whole, never is.
   */
  readonly judgeRole: DecisionJudgeRole;
  readonly classSignal: OpinionTypeClassSignal;
};

const PANEL = "panel-member" satisfies DecisionJudgeRole;
const DISSENTING = "dissenting" satisfies DecisionJudgeRole;

/**
 * Every opinion type the snapshot's opinion rows use, spelled as upstream
 * spells them (`015unamimous` included). Any other value is schema drift.
 */
export const OPINION_TYPES = {
  "010combined": { rank: 10, judgeRole: PANEL, classSignal: "none" },
  "015unamimous": { rank: 15, judgeRole: PANEL, classSignal: "opinion" },
  "020lead": { rank: 20, judgeRole: PANEL, classSignal: "opinion" },
  "025plurality": { rank: 25, judgeRole: PANEL, classSignal: "opinion" },
  "030concurrence": { rank: 30, judgeRole: PANEL, classSignal: "opinion" },
  "035concurrenceinpart": {
    rank: 35,
    judgeRole: PANEL,
    classSignal: "opinion",
  },
  "040dissent": { rank: 40, judgeRole: DISSENTING, classSignal: "opinion" },
  "050addendum": { rank: 50, judgeRole: PANEL, classSignal: "none" },
  "060remittitur": { rank: 60, judgeRole: PANEL, classSignal: "none" },
  "070rehearing": { rank: 70, judgeRole: PANEL, classSignal: "none" },
  "080onthemerits": { rank: 80, judgeRole: PANEL, classSignal: "opinion" },
  "090onmotiontostrike": { rank: 90, judgeRole: PANEL, classSignal: "order" },
  "100trialcourt": { rank: 100, judgeRole: PANEL, classSignal: "none" },
} as const satisfies Record<string, OpinionTypeDeclaration>;

export type OpinionType = keyof typeof OPINION_TYPES;

export const isOpinionType = (value: string): value is OpinionType =>
  Object.hasOwn(OPINION_TYPES, value);

/**
 * The citation row types, by the decimal the CSV holds. Type 8 is a
 * court-assigned neutral citation; every other declared type, the journal
 * category 9 included, names a printed publication and is kept as a reporter
 * tuple. An undeclared type is schema drift, not a reporter by default.
 */
export const CITATION_TYPES = {
  "1": DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
  "2": DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
  "3": DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
  "4": DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
  "5": DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
  "6": DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
  "7": DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
  "8": DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION,
  "9": DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
} as const;

export type CitationType = keyof typeof CITATION_TYPES;

export const isCitationType = (value: string): value is CitationType =>
  Object.hasOwn(CITATION_TYPES, value);
