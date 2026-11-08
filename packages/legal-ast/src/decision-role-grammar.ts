/**
 * The role grammar of a decision's language, for checks that read every
 * source's blocks: which line signs the decision, which opens its reasons,
 * which rules and which is the head matter before the ruling.
 *
 * Each language's vocabulary lives in its own owner (`czech-document-roles`,
 * `slovak-document-roles`, `polish-document-roles`), which the parsers of
 * that language call; this table only names them, so a check and a parser
 * can never read a line differently.
 */

import {
  isCzechReasonsHeading,
  isCzechSignatureLine,
} from "./czech-document-roles.js";
import {
  containsPlOperativeVerb,
  isPlAppealInstruction,
  isPlHoldingHeading,
  isPlReasonsHeading,
  isPlRecitalLine,
  isPlSignatureLine,
  opensPlRuling,
} from "./polish-document-roles.js";
import { isSkReasoningMarker } from "./slovak-document-roles.js";

export type DecisionRoleGrammar = {
  /** A line that opens the reasons: after it, nothing is the ruling. */
  readonly isReasonsHeading: (text: string) => boolean;
  /** A line that signs the decision, where the language has one to read. */
  readonly isSignatureLine?: (text: string) => boolean;
  /**
   * A line of the head matter before the ruling (the recital, the legal
   * basis), where the language has one to read.
   */
  readonly isRecitalLine?: (text: string) => boolean;
  /**
   * A line that instructs the parties on the remedy against the decision,
   * where the language has one to read: it is never the ruling.
   */
  readonly isAppealInstruction?: (text: string) => boolean;
  /** A line that rules: it holds an operative verb. */
  readonly isOperativeLine?: (text: string) => boolean;
  /**
   * A line that opens a ruling: a holding heading or a point opening on its
   * operative verb. A decision printing one before its reasons has a
   * holding.
   */
  readonly opensRuling?: (text: string) => boolean;
};

const isPlOperativeLine = (text: string): boolean =>
  containsPlOperativeVerb(text) || isPlHoldingHeading(text);

const DECISION_ROLE_GRAMMARS: ReadonlyMap<string, DecisionRoleGrammar> =
  new Map([
    [
      "cs",
      {
        isReasonsHeading: isCzechReasonsHeading,
        isSignatureLine: isCzechSignatureLine,
      },
    ],
    [
      "pl",
      {
        isReasonsHeading: isPlReasonsHeading,
        isSignatureLine: isPlSignatureLine,
        isRecitalLine: isPlRecitalLine,
        isAppealInstruction: isPlAppealInstruction,
        isOperativeLine: isPlOperativeLine,
        opensRuling: opensPlRuling,
      },
    ],
    ["sk", { isReasonsHeading: isSkReasoningMarker }],
  ]);

/** The grammar of a decision's language, or none where no owner reads it. */
export const decisionRoleGrammarOf = (
  language: string | undefined,
): DecisionRoleGrammar | undefined =>
  language === undefined ? undefined : DECISION_ROLE_GRAMMARS.get(language);
