/**
 * The role grammar of a decision's language, for checks that read every
 * source's blocks: which line signs the decision and which opens its
 * reasons.
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
  isPlReasonsHeading,
  isPlSignatureLine,
} from "./polish-document-roles.js";
import { isSkReasoningMarker } from "./slovak-document-roles.js";

export type DecisionRoleGrammar = {
  /** A line that opens the reasons: after it, nothing is the ruling. */
  readonly isReasonsHeading: (text: string) => boolean;
  /** A line that signs the decision, where the language has one to read. */
  readonly isSignatureLine?: (text: string) => boolean;
};

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
      },
    ],
    ["sk", { isReasonsHeading: isSkReasoningMarker }],
  ]);

/** The grammar of a decision's language, or none where no owner reads it. */
export const decisionRoleGrammarOf = (
  language: string | undefined,
): DecisionRoleGrammar | undefined =>
  language === undefined ? undefined : DECISION_ROLE_GRAMMARS.get(language);
