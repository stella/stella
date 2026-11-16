import { panic } from "better-result";

import {
  isClassifiablePolarity,
  POLARITY,
  POLARITY_RULE_KIND,
} from "@/api/handlers/case-law/polarity/consts";
import type {
  ClassifiablePolarity,
  Polarity,
  PolarityRuleKind,
} from "@/api/handlers/case-law/polarity/consts";

type RuleKindPolarity = {
  kind: PolarityRuleKind;
  polarity: Polarity;
};

export type ValidRuleKindPolarity =
  | {
      kind: typeof POLARITY_RULE_KIND.FORM;
      polarity: typeof POLARITY.NEUTRAL;
    }
  | {
      kind: typeof POLARITY_RULE_KIND.STANCE;
      polarity: ClassifiablePolarity;
    };

/** Form describes how a citation is printed; it cannot express treatment. */
export const isValidRuleKindPolarity = (
  rule: RuleKindPolarity,
): rule is ValidRuleKindPolarity =>
  isClassifiablePolarity(rule.polarity) &&
  (rule.kind === POLARITY_RULE_KIND.STANCE ||
    rule.polarity === POLARITY.NEUTRAL);

/** Why a stored rule cannot take part in matching. */
export const invalidRuleKindPolarityMessage = (polarity: Polarity) =>
  isClassifiablePolarity(polarity)
    ? "Citation-form rule carries a stance polarity"
    : "Polarity rule carries a polarity no match may assign";

/** A valid rule's kind and polarity, narrowed for its compiled form. */
export const typedRuleKindPolarity = (
  rule: ValidRuleKindPolarity,
): ValidRuleKindPolarity => {
  const { kind } = rule;
  switch (kind) {
    case POLARITY_RULE_KIND.FORM:
      return { kind: POLARITY_RULE_KIND.FORM, polarity: POLARITY.NEUTRAL };
    case POLARITY_RULE_KIND.STANCE:
      return { kind: POLARITY_RULE_KIND.STANCE, polarity: rule.polarity };
    default:
      kind satisfies never;
      return panic("Unhandled polarity rule kind");
  }
};
